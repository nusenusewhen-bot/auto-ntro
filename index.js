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
const BOT_MNEMONIC = process.env.BOT_MNEMONIC;

if (!BOT_MNEMONIC) {
  console.error('❌ ERROR: BOT_MNEMONIC not set!');
  process.exit(1);
}

const LITECOIN = { 
  messagePrefix: '\x19Litecoin Signed Message:\n', 
  bech32: 'ltc', 
  bip32: { public: 0x019da462, private: 0x019d9cfe }, 
  pubKeyHash: 0x30, 
  scriptHash: 0x32, 
  wif: 0xb0 
};

const ADDRESSES = [{ index: 0, address: 'Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU', inUse: false, ticketChannel: null, type: 'bech32' }];
let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();

function getWallet(index, type) {
  try {
    const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
    const root = bip32.fromSeed(seed, LITECOIN);
    const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
    if (!child.privateKey) throw new Error('No private key');
    const pubkey = Buffer.from(child.publicKey);
    const payment = type === 'bech32' 
      ? bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN })
      : bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getBalance(address) {
  try {
    const { data } = await axios.get(`https://litecoinspace.org/api/address/${address}`, { timeout: 15000 });
    const funded = (data.chain_stats?.funded_txo_sum || 0);
    const spent = (data.chain_stats?.spent_txo_sum || 0);
    const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
    const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
    return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
  } catch (e) {
    return 0;
  }
}

async function getConfirmedBalance(address) {
  try {
    const { data } = await axios.get(`https://litecoinspace.org/api/address/${address}`, { timeout: 15000 });
    const funded = (data.chain_stats?.funded_txo_sum || 0);
    const spent = (data.chain_stats?.spent_txo_sum || 0);
    return (funded - spent) / 100000000;
  } catch (e) {
    return 0;
  }
}

async function getUTXOs(address) {
  try {
    const { data } = await axios.get(`https://litecoinspace.org/api/address/${address}/utxo`, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const { data } = await axios.get(`https://litecoinspace.org/api/tx/${txid}/hex`, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, { headers: { 'Content-Type': 'text/plain' }, timeout: 15000 });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    if (!wallet || !wallet.privateKey) return { success: false, error: 'Wallet failed' };
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) return { success: false, error: 'No UTXOs' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let total = 0;
    
    for (let utxo of utxos) {
      if (utxo.status?.spent) continue;
      const raw = await getRawTx(utxo.txid);
      if (!raw) continue;
      
      if (addrInfo.type === 'bech32') {
        psbt.addInput({ hash: utxo.txid, index: utxo.vout, witnessUtxo: { script: Buffer.from(utxo.scriptpubkey, 'hex'), value: utxo.value }});
      } else {
        psbt.addInput({ hash: utxo.txid, index: utxo.vout, nonWitnessUtxo: Buffer.from(raw, 'hex') });
      }
      total += utxo.value;
    }
    
    if (total === 0) return { success: false, error: 'No inputs' };
    
    const fee = 100000;
    const sendAmount = total - fee;
    if (sendAmount <= 0) return { success: false, error: 'Too small' };
    
    psbt.addOutput({ address: toAddress, value: sendAmount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) {}
    }
    
    psbt.finalizeAllInputs();
    return await broadcastTx(psbt.extractTransaction().toHex());
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    try {
      const confirmed = await getConfirmedBalance(ticket.address);
      const pending = await getBalance(ticket.address);
      
      if (confirmed >= ticket.minLtc) {
        await processPayment(channelId, confirmed);
      } else if (pending > confirmed && !ticket.pendingNotified) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) {
          await ch.send('⏳ Pending payment detected...');
          ticket.pendingNotified = true;
        }
      }
    } catch (e) {
      console.error(`[CHECK] ${e.message}`);
    }
  }
}

async function processPayment(channelId, amount) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.paid) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    releaseAddress(channelId);
    tickets.delete(channelId);
    return;
  }
  
  ticket.paid = true;
  ticket.status = 'delivered';
  
  await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Payment Confirmed!').setDescription(`Received: **${amount.toFixed(8)} LTC**`).setColor(0x00FF00)] });
  
  const result = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  if (result.success) {
    await channel.send(`✅ Funds transferred`);
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ Transfer failed: ${result.error}`);
  }
}

async function deliverProduct(channel, ticket) {
  const products = { basic_month: 'Nitro Basic Monthly', basic_year: 'Nitro Basic Yearly', boost_month: 'Nitro Boost Monthly', boost_year: 'Nitro Boost Yearly' };
  await channel.send({ 
    content: `<@${ticket.userId}>`, 
    embeds: [new EmbedBuilder().setTitle('🎁 Your Order').setDescription(`**${products[ticket.product]}** x${ticket.quantity}\n\`\`\`diff\n+ CODE_${Date.now()}\n\`\`\``).setColor(0x5865F2)] 
  });
  await channel.send('⚠️ Closes in 5 minutes!');
  
  setTimeout(async () => {
    releaseAddress(channel.id);
    tickets.delete(channel.id);
    await channel.delete().catch(() => {});
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  const bal = await getBalance(ADDRESSES[0].address);
  console.log(`[WALLET] ${ADDRESSES[0].address} | ${bal.toFixed(8)} LTC`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set category').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send LTC').addStringOption(o => o.setName('address').setDescription('Address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check balance'),
    new SlashCommandBuilder().setName('check').setDescription('Check status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(checkPayments, 10000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    const isOwner = interaction.user.id === OWNER_ID;
    
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        if (!settings.ticketCategory) return interaction.reply({ content: '❌ Setup: /ticketcategory', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle('🛒 Nitro Shop').setDescription('💎 Basic: $1/mo $7/yr\n🔥 Boost: $2.80/mo $14/yr').setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛍️ Buy').setStyle(ButtonStyle.Success));
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      
      else if (interaction.commandName === 'balance') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ADDRESSES[0].address);
        await interaction.reply({ content: `💰 ${bal.toFixed(8)} LTC`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'send') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const to = interaction.options.getString('address');
        const result = await sendLTC(0, to);
        await interaction.editReply({ content: result.success ? `✅ TX: ${result.txid}` : `❌ ${result.error}` });
      }
      
      else if (interaction.commandName === 'close') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket', flags: MessageFlags.Ephemeral });
        if (ticket.userId !== interaction.user.id && !isOwner) return interaction.reply({ content: '❌ No permission', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
        releaseAddress(interaction.channel.id);
        tickets.delete(interaction.channel.id);
        setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }
      
      else if (interaction.commandName === 'check') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ No ticket', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ticket.address);
        await interaction.reply({ content: `Need: ${ticket.amountLtc.toFixed(8)} LTC\nHave: ${bal.toFixed(8)} LTC`, flags: MessageFlags.Ephemeral });
      }
      
      else if (['ticketcategory', 'staffroleid', 'salechannel'].includes(interaction.commandName)) {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : interaction.commandName === 'staffroleid' ? 'staffRole' : 'saleChannel';
        settings[key] = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Set`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (interaction.isButton() && interaction.customId === 'open_ticket') {
      if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup', flags: MessageFlags.Ephemeral });
      
      for (let [chId, t] of tickets) {
        if (t.userId === interaction.user.id && !t.paid) {
          const ch = interaction.guild.channels.cache.get(chId);
          if (ch) return interaction.reply({ content: `❌ You have ${ch}`, flags: MessageFlags.Ephemeral });
        }
      }
      
      const addr = ADDRESSES[0];
      if (addr.inUse) return interaction.reply({ content: '❌ Busy', flags: MessageFlags.Ephemeral });
      
      addr.inUse = true;
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
      
      addr.ticketChannel = channel.id;
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_product')
          .setPlaceholder('Select...')
          .addOptions(
            { label: 'Basic Monthly - $1', value: 'basic_month', emoji: '💎' },
            { label: 'Basic Yearly - $7', value: 'basic_year', emoji: '💎' },
            { label: 'Boost Monthly - $2.80', value: 'boost_month', emoji: '🔥' },
            { label: 'Boost Yearly - $14', value: 'boost_year', emoji: '🔥' }
          )
      );
      
      await channel.send({ 
        content: `${interaction.user}`, 
        embeds: [new EmbedBuilder().setTitle('🛒 Select').setDescription(`Pay to:\n\`${addr.address}\``).setColor(0x5865F2)], 
        components: [row] 
      });
      
      tickets.set(channel.id, {
        userId: interaction.user.id,
        status: 'selecting',
        walletIndex: 0,
        address: addr.address,
        product: null,
        price: null,
        quantity: 1,
        amountLtc: null,
        minLtc: null,
        maxLtc: null,
        paid: false,
        pendingNotified: false
      });
      
      await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_product') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket || ticket.userId !== interaction.user.id) return;
      
      const prices = { basic_month: 1, basic_year: 7, boost_month: 2.8, boost_year: 14 };
      ticket.product = interaction.values[0];
      ticket.price = prices[ticket.product];
      
      const modal = new ModalBuilder()
        .setCustomId('qty_modal')
        .setTitle('Quantity')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('qty').setLabel('How many?').setStyle(TextInputStyle.Short).setValue('1').setRequired(true)));
      
      await interaction.showModal(modal);
    }
    
    if (interaction.isModalSubmit() && interaction.customId === 'qty_modal') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket) return;
      
      const qty = parseInt(interaction.fields.getTextInputValue('qty')) || 1;
      const totalUsd = ticket.price * qty;
      const totalLtc = totalUsd / 75;
      const tolerance = totalLtc * 0.5;
      
      ticket.quantity = qty;
      ticket.amountLtc = totalLtc;
      ticket.minLtc = totalLtc - tolerance;
      ticket.maxLtc = totalLtc + tolerance;
      ticket.status = 'awaiting_payment';
      
      await interaction.reply({ 
        embeds: [new EmbedBuilder()
          .setTitle('💳 Pay')
          .setDescription(`Send: \`${totalLtc.toFixed(8)} LTC\`\nTo: \`${ticket.address}\`\nMin: ${ticket.minLtc.toFixed(8)} | Max: ${ticket.maxLtc.toFixed(8)}`)
          .setColor(0xFFD700)
        ] 
      });
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Error', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
