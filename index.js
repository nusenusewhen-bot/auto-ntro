require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, MessageFlags } = require('discord.js');
const axios = require('axios');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const ECPairFactory = require('ecpair');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

const OWNER_ID = '1459833646130401429';
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const BLOCKCHAIR_KEY = process.env.BLOCKCHAIR_KEY;
const BOT_MNEMONIC = process.env.BOT_MNEMONIC;
const TOLERANCE_PERCENT = 0.50;

const LITECOIN = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

let ltcPrice = 75;
let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const usedStock = new Set();
let addressIndex = 0;

const PRODUCTS = {
  nitro_basic_month: { name: 'Nitro Basic Monthly', price: 1.0, stock: ['link1','link2','link3','link4','link5'] },
  nitro_basic_year: { name: 'Nitro Basic Yearly', price: 7.0, stock: ['link1','link2','link3'] },
  nitro_boost_month: { name: 'Nitro Boost Monthly', price: 2.8, stock: ['link1','link2','link3','link4'] },
  nitro_boost_year: { name: 'Nitro Boost Yearly', price: 14.0, stock: ['link1','link2'] },
  members_offline: { name: 'Members (Offline)', price: 0.7, unit: 1000, type: 'calculated' },
  members_online: { name: 'Members (Online)', price: 1.5, unit: 1000, type: 'calculated' }
};

function getLitecoinAddress(index) {
  const safeIndex = Math.max(0, Math.min(9, parseInt(index) || 0));
  
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${safeIndex}`);
  const pubkey = Buffer.from(child.publicKey);
  
  // Generate all possible address formats
  const legacy = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  const segwitP2sh = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN }), network: LITECOIN });
  const nativeSegwit = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  
  // Also generate capitalized versions of Bech32 (some wallets use Lc1... or LTC1...)
  const nativeSegwitUpper = nativeSegwit.address ? nativeSegwit.address.toUpperCase().replace('LTC1', 'Lc1') : null;
  
  return { 
    legacy: legacy.address,           // L... (P2PKH)
    segwitP2sh: segwitP2sh.address,     // M... (P2SH-P2WPKH)
    nativeSegwit: nativeSegwit.address, // ltc1... (P2WPKH Bech32)
    nativeSegwitUpper: nativeSegwitUpper, // Lc1... (Capitalized Bech32)
    privateKey: keyPair.toWIF(), 
    index: safeIndex,
    publicKey: pubkey.toString('hex')
  };
}

async function checkAddressBalance(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?key=${BLOCKCHAIR_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (data?.data?.[address]) {
      const addr = data.data[address].address;
      const balance = (addr.balance || 0) / 100000000;
      const received = (addr.received || 0) / 100000000;
      const spent = (addr.spent || 0) / 100000000;
      const unconfirmed = Math.max(0, received - spent - balance);
      
      const utxos = (data.data[address].utxo || []).map(u => ({
        txid: u.transaction_hash,
        vout: u.index,
        value: parseInt(u.value),
        script: u.script_hex
      }));
      
      return { 
        success: true, 
        confirmed: balance, 
        unconfirmed: unconfirmed,
        total: balance + unconfirmed,
        utxos: utxos,
        address: address,
        raw: data.data[address]
      };
    }
    return { success: false, total: 0, utxos: [] };
  } catch (error) {
    console.log(`[CHECK ERROR] ${address}: ${error.message}`);
    return { success: false, total: 0, utxos: [] };
  }
}

async function getAddressState(addressOrIndex) {
  // If number passed, get all formats for that index
  if (typeof addressOrIndex === 'number') {
    const wallet = getLitecoinAddress(addressOrIndex);
    
    console.log(`[INDEX ${addressOrIndex}] Checking all formats:`);
    console.log(`  Legacy: ${wallet.legacy}`);
    console.log(`  SegWit P2SH: ${wallet.segwitP2sh}`);
    console.log(`  Native SegWit: ${wallet.nativeSegwit}`);
    console.log(`  Native SegWit Upper: ${wallet.nativeSegwitUpper}`);
    
    // Check ALL formats and return the one with highest balance
    const checks = await Promise.all([
      checkAddressBalance(wallet.legacy),
      checkAddressBalance(wallet.segwitP2sh),
      checkAddressBalance(wallet.nativeSegwit),
      wallet.nativeSegwitUpper ? checkAddressBalance(wallet.nativeSegwitUpper) : { success: false, total: 0 }
    ]);
    
    // Also try lowercase version of capitalized address if provided
    let targetAddress = null;
    let bestBalance = 0;
    let bestResult = null;
    
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i];
      const format = ['legacy', 'segwitP2sh', 'nativeSegwit', 'nativeSegwitUpper'][i];
      console.log(`  ${format}: ${check.total.toFixed(8)} LTC`);
      
      if (check.total > bestBalance) {
        bestBalance = check.total;
        bestResult = check;
        targetAddress = check.address;
      }
    }
    
    if (bestResult && bestBalance > 0) {
      console.log(`[FOUND] Best format: ${targetAddress} with ${bestBalance.toFixed(8)} LTC`);
      return {
        confirmed: bestResult.confirmed,
        unconfirmed: bestResult.unconfirmed,
        total: bestResult.total,
        utxos: bestResult.utxos,
        address: targetAddress,
        wallet: wallet
      };
    }
    
    // Return default (legacy) if no balance found
    return {
      confirmed: 0,
      unconfirmed: 0,
      total: 0,
      utxos: [],
      address: wallet.legacy,
      wallet: wallet
    };
  }
  
  // If specific address passed, check it directly
  return await checkAddressBalance(addressOrIndex);
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const safeIndex = Math.max(0, Math.min(9, parseInt(fromIndex) || 0));
    const state = await getAddressState(safeIndex);
    
    if (state.total <= 0.0001) {
      return { success: false, error: `No balance on index ${safeIndex}. Checked all formats.` };
    }
    
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs available' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const { data } = await axios.get(txUrl, { timeout: 10000 });
        
        if (data?.data?.[utxo.txid]?.raw_transaction) {
          const rawTx = Buffer.from(data.data[utxo.txid].raw_transaction, 'hex');
          
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          });
          
          totalInput += utxo.value;
        }
      } catch (e) {
        console.log(`[SEND] Failed to add input: ${e.message}`);
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }
    
    const fee = 100000; // 0.001 LTC
    const amount = totalInput - fee;
    
    if (amount <= 0) {
      return { success: false, error: 'Balance too small for fee' };
    }
    
    psbt.addOutput({ address: toAddress, value: amount });
    
    const wallet = getLitecoinAddress(safeIndex);
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        console.log(`[SEND] Sign error input ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcast = await axios.post(
      `https://api.blockchair.com/litecoin/push/transaction?key=${BLOCKCHAIR_KEY}`,
      { data: txHex },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    
    if (broadcast.data?.data?.transaction_hash) {
      return {
        success: true,
        txid: broadcast.data.data.transaction_hash,
        amount: amount / 100000000,
        fee: fee / 100000000,
        fromAddress: state.address
      };
    } else {
      return { success: false, error: 'Broadcast failed', details: broadcast.data };
    }
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel (Owner)'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category (Owner)').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role (Owner)').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View current settings (Owner)'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner)').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket (Owner/Staff)'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Manually check payment status (Owner)'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid and deliver (Owner)'),
    new SlashCommandBuilder().setName('oauth2').setDescription('Get bot invite (Owner)'),
    new SlashCommandBuilder().setName('debug').setDescription('Debug wallet addresses (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true))
  ];
  
  await client.application.commands.set(commands);
  setInterval(monitorMempool, 5000);
  console.log('[SYSTEM] Payment monitoring started');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  const isOwner = interaction.user.id === OWNER_ID;
  const isStaff = settings.staffRole && interaction.member?.roles?.cache?.has(settings.staffRole);
  
  if (!isOwner && !['close'].includes(interaction.commandName)) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'close' && !isOwner && !isStaff) {
    return interaction.reply({ content: '❌ Owner or Staff only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) {
      return interaction.reply({ 
        content: `❌ **Not setup!** Use:\n1. \`/ticketcategory\`\n2. \`/staffroleid\`\n3. \`/transcriptchannel\`\n4. \`/salechannel\``, 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    const embed = new EmbedBuilder()
      .setTitle('🏪 Hello welcome to Nitro Shop')
      .setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken')
      .setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'debug') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 9) return interaction.reply({ content: '❌ Index 0-9 only', flags: MessageFlags.Ephemeral });
    
    const wallet = getLitecoinAddress(idx);
    
    // Check all formats
    const legacyCheck = await checkAddressBalance(wallet.legacy);
    const segwitCheck = await checkAddressBalance(wallet.segwitP2sh);
    const nativeCheck = await checkAddressBalance(wallet.nativeSegwit);
    const nativeUpperCheck = wallet.nativeSegwitUpper ? await checkAddressBalance(wallet.nativeSegwitUpper) : { total: 0 };
    
    const embed = new EmbedBuilder()
      .setTitle(`🔍 Debug Wallet ${idx}`)
      .addFields(
        { name: `Legacy (L...) - ${legacyCheck.total.toFixed(8)} LTC`, value: `\`${wallet.legacy}\``, inline: false },
        { name: `SegWit P2SH (M...) - ${segwitCheck.total.toFixed(8)} LTC`, value: `\`${wallet.segwitP2sh}\``, inline: false },
        { name: `Native SegWit (ltc1...) - ${nativeCheck.total.toFixed(8)} LTC`, value: `\`${wallet.nativeSegwit}\``, inline: false },
        { name: `Native SegWit Upper (Lc1...) - ${nativeUpperCheck.total.toFixed(8)} LTC`, value: `\`${wallet.nativeSegwitUpper || 'N/A'}\``, inline: false }
      )
      .setColor(0x00FF00);
    
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'settings') {
    await interaction.reply({
      content: `**Settings:**\nCategory: ${settings.ticketCategory || '❌'}\nStaff: ${settings.staffRole || '❌'}\nTranscript: ${settings.transcriptChannel || '❌'}\nSale: ${settings.saleChannel || '❌'}`,
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'ticketcategory') { 
    settings.ticketCategory = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Category set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'staffroleid') { 
    settings.staffRole = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Staff role set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'transcriptchannel') { 
    settings.transcriptChannel = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Transcript set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'salechannel') { 
    settings.saleChannel = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Sale channel set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    
    let results = [];
    for (let i = 0; i <= 9; i++) {
      const result = await sendAllLTC(i, address);
      if (result.success) {
        results.push(`✅ Index ${i}: Sent ${result.amount.toFixed(8)} LTC from ${result.fromAddress.slice(0,15)}...`);
      }
    }
    
    if (results.length === 0) {
      // Try to show which indices have balance
      let debugInfo = [];
      for (let i = 0; i <= 9; i++) {
        const state = await getAddressState(i);
        if (state.total > 0) {
          debugInfo.push(`Index ${i}: ${state.total.toFixed(8)} LTC at ${state.address.slice(0,15)}...`);
        }
      }
      
      let msg = '❌ No funds sent. ';
      if (debugInfo.length > 0) {
        msg += `Found balance but failed to send:\n${debugInfo.join('\n')}`;
      } else {
        msg += 'No balance found on any index (0-9) in any format.';
      }
      await interaction.editReply({ content: msg });
    } else {
      await interaction.editReply({ content: results.join('\n') });
    }
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 9) return interaction.reply({ content: '❌ Index 0-9 only', flags: MessageFlags.Ephemeral });
    
    const state = await getAddressState(idx);
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Active Address:** \`${state.address}\`\nConfirmed: ${state.confirmed.toFixed(8)} LTC\nUnconfirmed: ${state.unconfirmed.toFixed(8)} LTC\n**Total: ${state.total.toFixed(8)} LTC**`)
        .setColor(state.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    
    await interaction.deferReply();
    const state = await getAddressState(ticket.walletIndex);
    
    let text = `**Payment Check for Index ${ticket.walletIndex}**\n`;
    text += `Checking address: ${state.address}\n`;
    text += `Expected: ${ticket.amountLtc} LTC\n`;
    text += `Detected: ${state.total.toFixed(8)} LTC\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else if (state.total > 0) {
      text += `⚠️ Payment outside tolerance. Min: ${ticket.minLtc}, Max: ${ticket.maxLtc}`;
      await interaction.editReply({ content: text });
    } else {
      text += `❌ No payment detected`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    
    await interaction.reply({ content: '🔄 Forcing...', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(ticket.walletIndex);
    await processPayment(interaction.channel.id, state.total > 0 ? state.total : (ticket.amountLtc || 0.01));
  }
  else if (interaction.commandName === 'close') {
    tickets.delete(interaction.channel.id);
    await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  else if (interaction.commandName === 'oauth2') {
    await interaction.reply({ 
      content: `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`, 
      flags: MessageFlags.Ephemeral 
    });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) {
      return interaction.reply({ content: `❌ Not setup! Use /ticketcategory first.`, flags: MessageFlags.Ephemeral });
    }
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (addressIndex > 9) addressIndex = 0;
    
    // Get the address with highest balance for this index, or default to legacy
    const state = await getAddressState(addressIndex);
    const useAddress = state.address;
    
    const channel = await interaction.guild.channels.create({
      name: `nitro-${interaction.user.username}`,
      type: ChannelType.GuildText,
      parent: settings.ticketCategory,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ...(settings.staffRole ? [{ id: settings.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : [])
      ]
    });
    
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('product_select')
        .setPlaceholder('Select Product')
        .addOptions(
          { label: 'Nitro Basic Monthly - $1.00', value: 'nitro_basic_month', emoji: '💎' },
          { label: 'Nitro Basic Yearly - $7.00', value: 'nitro_basic_year', emoji: '💎' },
          { label: 'Nitro Boost Monthly - $2.80', value: 'nitro_boost_month', emoji: '🔥' },
          { label: 'Nitro Boost Yearly - $14.00', value: 'nitro_boost_year', emoji: '🔥' },
          { label: 'Members', value: 'members', emoji: '👥' }
        )
    );
    
    await channel.send({ 
      content: `${interaction.user}`, 
      embeds: [new EmbedBuilder().setTitle('🛒 Select Product').setColor(0x00FF00)], 
      components: [row] 
    });
    
    tickets.set(channel.id, { 
      userId: interaction.user.id, 
      status: 'selecting', 
      channelId: channel.id,
      walletIndex: addressIndex,  // Store index, not address
      address: useAddress,
      product: null,
      productName: null,
      price: null,
      quantity: null,
      amountUsd: null,
      amountLtc: null,
      minLtc: null,
      maxLtc: null,
      paid: false,
      delivered: false
    });
    
    console.log(`[TICKET] ${channel.id} -> Index ${addressIndex}, Address: ${useAddress}`);
    addressIndex++;
    if (addressIndex > 9) addressIndex = 0;
    
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
    const productKey = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    if (productKey === 'members') {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('members_type_select')
          .setPlaceholder('Choose Members Type')
          .addOptions(
            { label: 'Offline Members - $0.70 per 1000', value: 'members_offline', emoji: '⚫' },
            { label: 'Online Members - $1.50 per 1000', value: 'members_online', emoji: '🟢' }
          )
      );
      return interaction.update({ embeds: [new EmbedBuilder().setTitle('👥 Choose Type').setColor(0x00FF00)], components: [row] });
    }
    
    const product = PRODUCTS[productKey];
    ticket.product = productKey;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.productType = 'standard';
    
    const modal = new ModalBuilder()
      .setCustomId('qty')
      .setTitle('Quantity')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('How many?').setStyle(TextInputStyle.Short).setPlaceholder('1').setRequired(true)));
    
    await interaction.showModal(modal);
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'members_type_select') {
    const membersType = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const product = PRODUCTS[membersType];
    ticket.product = membersType;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.unit = product.unit;
    ticket.productType = 'calculated';
    
    const modal = new ModalBuilder()
      .setCustomId('members_qty')
      .setTitle('Enter Amount')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('member_amount').setLabel('How many members?').setStyle(TextInputStyle.Short).setPlaceholder('1000').setRequired(true)));
    
    await interaction.showModal(modal);
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'qty') {
    const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const available = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s));
    if (available.length < qty) return interaction.reply({ content: `❌ Only ${available.length} left`, flags: MessageFlags.Ephemeral });
    
    const totalUsd = ticket.price * qty;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = qty;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment')
        .setDescription(`**${ticket.productName}** x${qty}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` }
        )
        .setColor(0xFFD700)
      ] 
    });
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'members_qty') {
    const memberAmount = parseInt(interaction.fields.getTextInputValue('member_amount'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    if (isNaN(memberAmount) || memberAmount < 1000) return interaction.reply({ content: '❌ Minimum 1000', flags: MessageFlags.Ephemeral });
    
    const units = memberAmount / ticket.unit;
    const totalUsd = units * ticket.price;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = memberAmount;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment - Members')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${memberAmount.toLocaleString()} members\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields({ name: '📋 LTC Address', value: `\`${ticket.address}\`` })
        .setColor(0xFFD700)
      ] 
    });
  }
});

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment');
  
  for (const [channelId, ticket] of awaiting) {
    try {
      // Use index to check all formats
      const state = await getAddressState(ticket.walletIndex);
      console.log(`[MONITOR] Index ${ticket.walletIndex} (${state.address.slice(0,10)}...): ${state.total.toFixed(8)} LTC`);
      
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        console.log(`[MONITOR] ✅ PAYMENT DETECTED`);
        await processPayment(channelId, state.total);
      }
    } catch (error) {
      console.error(`[MONITOR] Error:`, error.message);
    }
  }
}

async function processPayment(channelId, receivedLtc) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.status === 'delivered') return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    tickets.delete(channelId);
    return;
  }
  
  ticket.status = 'delivered';
  ticket.paid = true;
  
  console.log(`[AUTO-SEND] From index ${ticket.walletIndex} to ${FEE_ADDRESS}`);
  const sendResult = await sendAllLTC(ticket.walletIndex, FEE_ADDRESS);
  
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle('⏳ Payment Confirmed')
      .setDescription(`Received: ${receivedLtc.toFixed(8)} LTC\nAuto-send: ${sendResult.success ? '✅' : '❌'}\n\nWait for owner to deliver.`)
      .setColor(0xFFA500)
    ]
  });
  
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (owner) {
    owner.send({
      embeds: [new EmbedBuilder()
        .setTitle('🛒 New Order')
        .setDescription(`**Product:** ${ticket.productName}\n**Qty:** ${ticket.quantity}\n**Amount:** $${ticket.amountUsd.toFixed(2)}\n**LTC:** ${receivedLtc.toFixed(8)}\n**Channel:** <#${channelId}>`)
        .setColor(0x00FF00)
      ]
    });
  }
  
  await deliverProducts(channelId, receivedLtc);
}

async function deliverProducts(channelId, receivedLtc) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.delivered) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  
  if (ticket.productType === 'calculated') {
    ticket.delivered = true;
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🎁 Order Confirmed')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${ticket.quantity.toLocaleString()} members\nOwner notified.`)
        .setColor(0x00FF00)
      ]
    });
    return;
  }
  
  const productList = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s)).slice(0, ticket.quantity);
  if (productList.length === 0) {
    return channel.send({ embeds: [new EmbedBuilder().setTitle('❌ Out of Stock').setColor(0xFF0000)] });
  }
  
  productList.forEach(p => usedStock.add(p));
  ticket.productsSent = productList;
  ticket.delivered = true;
  
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Links')
    .setDescription(`**${ticket.productName}** x${productList.length}`)
    .setColor(0x00FF00);
  
  productList.forEach((item, idx) => embed.addFields({ name: `Link ${idx + 1}`, value: item }));
  
  await channel.send({ embeds: [embed] });
  console.log(`[DELIVERED] ${channelId} - ${ticket.productName} x${productList.length}`);
}

client.login(process.env.DISCORD_TOKEN);
