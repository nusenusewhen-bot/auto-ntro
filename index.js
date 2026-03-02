require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const ECPairFactory = require('ecpair');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const OWNER_ID = '1459833646130401429';
const BOT_MNEMONIC = process.env.BOT_MNEMONIC;

if (!BOT_MNEMONIC || !bip39.validateMnemonic(BOT_MNEMONIC)) {
  console.error('❌ Invalid mnemonic!');
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

// Cache wallets so we only generate once
const WALLETS = {};

function generateWallets() {
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  
  for (let i = 0; i < 3; i++) {
    try {
      const child = root.derivePath(`m/44'/2'/0'/0/${i}`);
      
      if (!child.privateKey) {
        console.error(`[WALLET ${i}] No private key`);
        continue;
      }
      
      const privateKey = Buffer.from(child.privateKey);
      const publicKey = Buffer.from(child.publicKey);
      const type = i === 0 ? 'bech32' : 'legacy';
      
      const payment = type === 'bech32' 
        ? bitcoin.payments.p2wpkh({ pubkey: publicKey, network: LITECOIN })
        : bitcoin.payments.p2pkh({ pubkey: publicKey, network: LITECOIN });
      
      const keyPair = ECPair.fromPrivateKey(privateKey, { network: LITECOIN });
      
      WALLETS[i] = {
        address: payment.address,
        privateKey: keyPair.toWIF(),
        type: type
      };
      
      console.log(`[WALLET ${i}] ${payment.address}`);
    } catch (e) {
      console.error(`[WALLET ${i}] Error: ${e.message}`);
    }
  }
}

// Generate once on startup
generateWallets();

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

async function sendAllLTC(index, toAddress) {
  const wallet = WALLETS[index];
  if (!wallet) {
    return { success: false, error: `Index ${index}: Wallet not loaded` };
  }
  
  const utxos = await getUTXOs(wallet.address);
  if (utxos.length === 0) {
    return { success: false, error: `Index ${index}: No UTXOs` };
  }
  
  const psbt = new bitcoin.Psbt({ network: LITECOIN });
  let total = 0;
  
  for (let utxo of utxos) {
    if (utxo.status?.spent) continue;
    const raw = await getRawTx(utxo.txid);
    if (!raw) continue;
    
    if (wallet.type === 'bech32') {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptpubkey, 'hex'),
          value: utxo.value
        }
      });
    } else {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(raw, 'hex')
      });
    }
    total += utxo.value;
  }
  
  if (total === 0) {
    return { success: false, error: `Index ${index}: No valid inputs` };
  }
  
  const fee = 100000;
  const sendAmount = total - fee;
  if (sendAmount <= 0) {
    return { success: false, error: `Index ${index}: Amount too small` };
  }
  
  psbt.addOutput({ address: toAddress, value: sendAmount });
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
  for (let i = 0; i < psbt.inputCount; i++) {
    try { psbt.signInput(i, keyPair); } catch (e) {}
  }
  
  psbt.finalizeAllInputs();
  const result = await broadcastTx(psbt.extractTransaction().toHex());
  if (result.success) {
    result.amount = (sendAmount / 100000000).toFixed(8);
  }
  return result;
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send all LTC from all indices')
      .addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true))
  ];
  
  await client.application.commands.set(commands);
  console.log('[COMMANDS] /send ready');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'send') return;
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  await interaction.deferReply();
  const toAddress = interaction.options.getString('address');
  let results = [];
  
  for (let i = 0; i < 3; i++) {
    const result = await sendAllLTC(i, toAddress);
    if (result.success) {
      results.push(`✅ [${i}] Sent ${result.amount} LTC\nTX: ${result.txid}`);
    } else {
      results.push(`❌ [${i}] ${result.error}`);
    }
  }
  
  await interaction.editReply({ content: results.join('\n\n') });
});

client.login(process.env.DISCORD_TOKEN);
