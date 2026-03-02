require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { initWallet, sendAllLTC, getBalanceAtIndex, generateAddress } = require('./wallet');
const { getLtcPriceUSD } = require('./blockchain');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const OWNER_ID = process.env.OWNER_ID || '1459833646130401429';

if (!process.env.BOT_MNEMONIC) {
  console.error('❌ BOT_MNEMONIC not set!');
  process.exit(1);
}

const walletInitialized = initWallet(process.env.BOT_MNEMONIC);
if (!walletInitialized) {
  console.error('❌ Wallet init failed!');
  process.exit(1);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send all LTC to address (Owner only)')
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
  const address = interaction.options.getString('address').trim();
  
  if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
    return interaction.editReply({ content: '❌ Invalid LTC address' });
  }

  let results = [];
  
  // Send from indices 0, 1, 2
  for (let i = 0; i < 3; i++) {
    const balance = await getBalanceAtIndex(i, true);
    
    if (balance <= 0) {
      results.push(`❌ [${i}] No balance (${generateAddress(i)})`);
      continue;
    }

    const result = await sendAllLTC(i, address);
    
    if (result.success) {
      results.push(`✅ [${i}] Sent ${result.amountSent} LTC\nTX: ${result.txid}`);
    } else {
      results.push(`❌ [${i}] ${result.error}`);
    }
  }
  
  await interaction.editReply({ content: results.join('\n\n') || 'No funds found' });
});

client.login(process.env.DISCORD_TOKEN);
