require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { initWallet, sendAllLTC, generateAddress } = require('./wallet');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const OWNER_ID = '1459833646130401429';
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';

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
      .setDescription('Send all LTC to fee address')
  ]);
  
  console.log('[COMMANDS] /send ready');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'send') return;
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  let results = [];
  
  for (let i = 0; i < 3; i++) {
    const address = generateAddress(i);
    console.log(`[SEND] Index ${i}: ${address} -> ${FEE_ADDRESS}`);
    
    const result = await sendAllLTC(i, FEE_ADDRESS);
    results.push(result.success 
      ? `✅ [${i}] Sent ${result.amountSent} LTC\nTX: ${result.txid}`
      : `❌ [${i}] ${result.error}`
    );
  }
  
  await interaction.editReply({ 
    embeds: [new EmbedBuilder().setTitle('💰 Send Results').setDescription(results.join('\n\n')).setColor(0x00FF00)] 
  });
});

client.login(process.env.DISCORD_TOKEN);
