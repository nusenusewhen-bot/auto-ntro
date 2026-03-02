require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { initWallet, sendAllLTC, getBalanceAtIndex, generateAddress } = require('./wallet');

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
  
  await client.application.commands.set([
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send all LTC from all indices')
      .addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true))
  ]);
  
  console.log('[COMMANDS] /send ready');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'send') return;
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  const address = interaction.options.getString('address').trim();
  
  if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
    return interaction.editReply({ content: '❌ Invalid address' });
  }

  let results = [];
  
  for (let i = 0; i < 3; i++) {
    const balance = await getBalanceAtIndex(i, true);
    if (balance <= 0) {
      results.push(`❌ [${i}] No balance`);
      continue;
    }
    const result = await sendAllLTC(i, address);
    results.push(result.success 
      ? `✅ [${i}] Sent ${result.amountSent} LTC\nTX: ${result.txid}`
      : `❌ [${i}] ${result.error}`
    );
  }
  
  await interaction.editReply({ 
    embeds: [new EmbedBuilder().setTitle('💰 Results').setDescription(results.join('\n\n')).setColor(0x00FF00)] 
  });
});

client.login(process.env.DISCORD_TOKEN);
