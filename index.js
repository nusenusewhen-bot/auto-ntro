require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, PermissionFlagsBits, ChannelType, Events, SlashCommandBuilder } = require('discord.js');
const Database = require('better-sqlite3');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const db = new Database('ticketbot.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    guild_id TEXT PRIMARY KEY,
    ticket_category TEXT,
    support_category TEXT,
    staff_role TEXT
  );
  
  CREATE TABLE IF NOT EXISTS tickets (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT,
    user_id TEXT,
    type TEXT,
    buying TEXT,
    quantity TEXT,
    payment_method TEXT,
    help_topic TEXT,
    explanation TEXT,
    auto_msg_sent INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

const getSettings = (guildId) => {
  return db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(guildId);
};

const saveSettings = (guildId, data) => {
  const existing = getSettings(guildId);
  if (existing) {
    db.prepare('UPDATE settings SET ticket_category = ?, support_category = ?, staff_role = ? WHERE guild_id = ?')
      .run(data.ticket_category, data.support_category, data.staff_role, guildId);
  } else {
    db.prepare('INSERT INTO settings (guild_id, ticket_category, support_category, staff_role) VALUES (?, ?, ?, ?)')
      .run(guildId, data.ticket_category, data.support_category, data.staff_role);
  }
};

const createTicket = (data) => {
  db.prepare('INSERT INTO tickets (channel_id, guild_id, user_id, type, buying, quantity, payment_method, help_topic, explanation, auto_msg_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.channel_id, data.guild_id, data.user_id, data.type, data.buying || null, data.quantity || null, data.payment_method || null, data.help_topic || null, data.explanation || null, data.auto_msg_sent || 0);
};

const getTicket = (channelId) => {
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
};

const markAutoMsgSent = (channelId) => {
  db.prepare('UPDATE tickets SET auto_msg_sent = 1 WHERE channel_id = ?').run(channelId);
};

const deleteTicket = (channelId) => {
  db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(channelId);
};

const commands = [
  new SlashCommandBuilder()
    .setName('ticketcategory')
    .setDescription('Set the category for purchase tickets')
    .addStringOption(opt => opt.setName('categoryid').setDescription('Category ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
  new SlashCommandBuilder()
    .setName('supportcategory')
    .setDescription('Set the category for support tickets')
    .addStringOption(opt => opt.setName('categoryid').setDescription('Category ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
  new SlashCommandBuilder()
    .setName('staffrole')
    .setDescription('Set the staff role that can see tickets')
    .addStringOption(opt => opt.setName('roleid').setDescription('Role ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Spawn the main purchase ticket panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
  new SlashCommandBuilder()
    .setName('support')
    .setDescription('Spawn the support ticket panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName, guildId } = interaction;
      
      if (commandName === 'ticketcategory') {
        const categoryId = interaction.options.getString('categoryid');
        const settings = getSettings(guildId) || {};
        settings.ticket_category = categoryId;
        saveSettings(guildId, settings);
        await interaction.reply({ content: `✅ Purchase ticket category set to: \`${categoryId}\``, ephemeral: true });
      }
      
      if (commandName === 'supportcategory') {
        const categoryId = interaction.options.getString('categoryid');
        const settings = getSettings(guildId) || {};
        settings.support_category = categoryId;
        saveSettings(guildId, settings);
        await interaction.reply({ content: `✅ Support ticket category set to: \`${categoryId}\``, ephemeral: true });
      }
      
      if (commandName === 'staffrole') {
        const roleId = interaction.options.getString('roleid');
        const settings = getSettings(guildId) || {};
        settings.staff_role = roleId;
        saveSettings(guildId, settings);
        await interaction.reply({ content: `✅ Staff role set to: <@&${roleId}>`, ephemeral: true });
      }
      
      if (commandName === 'panel') {
        const embed = new EmbedBuilder()
          .setTitle('🛒 Purchase Ticket')
          .setDescription(`All sales are final – No refunds will be issued under any circumstances.
          
**Crypto Payments Only** – Only Litecoin is accepted.

**No Spamming** – Do not spam while completing a purchase.

**Deals & Payments** – All deals must be completed inside our ticket system.

**No Promo/Ads** – Any advertising or asking others for products/services = ban or 1-day timeout.

**Warranty** – All warranty information is clearly stated on each product.

**Equal Treatment** – Every client is treated the same. No special exceptions for anyone.

**Policy Updates** – We reserve the right to change these Terms of Service at any time.`)
          .setColor(0x5865F2)
          .setTimestamp();
          
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('open_purchase_ticket')
            .setLabel('Open Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🎫')
        );
        
        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: '✅ Purchase panel spawned!', ephemeral: true });
      }
      
      if (commandName === 'support') {
        const embed = new EmbedBuilder()
          .setTitle('🎧 Support Service')
          .setDescription('Welcome to Support Service, Please wait patiently and send proofs if you got.')
          .setColor(0x57F287)
          .setTimestamp();
          
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('open_support_ticket')
            .setLabel('Open Support Ticket')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎧')
        );
        
        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: '✅ Support panel spawned!', ephemeral: true });
      }
    }
    
    if (interaction.isButton()) {
      const { customId, guild, user } = interaction;
      
      if (customId === 'open_purchase_ticket') {
        const modal = new ModalBuilder()
          .setCustomId('purchase_modal')
          .setTitle('Purchase Information');
          
        const buyingInput = new TextInputBuilder()
          .setCustomId('buying')
          .setLabel('What are you buying?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100);
          
        const quantityInput = new TextInputBuilder()
          .setCustomId('quantity')
          .setLabel('Quantity/Amount')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);
          
        const paymentInput = new TextInputBuilder()
          .setCustomId('payment_method')
          .setLabel('Payment method')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);
          
        modal.addComponents(
          new ActionRowBuilder().addComponents(buyingInput),
          new ActionRowBuilder().addComponents(quantityInput),
          new ActionRowBuilder().addComponents(paymentInput)
        );
        
        await interaction.showModal(modal);
      }
      
      if (customId === 'open_support_ticket') {
        const modal = new ModalBuilder()
          .setCustomId('support_modal')
          .setTitle('Support Request');
          
        const helpInput = new TextInputBuilder()
          .setCustomId('help_topic')
          .setLabel('What do you need help with?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100);
          
        const explainInput = new TextInputBuilder()
          .setCustomId('explanation')
          .setLabel('Explanation')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);
          
        modal.addComponents(
          new ActionRowBuilder().addComponents(helpInput),
          new ActionRowBuilder().addComponents(explainInput)
        );
        
        await interaction.showModal(modal);
      }
      
      if (customId === 'close_ticket') {
        const ticket = getTicket(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
        
        await interaction.reply({ content: '🔒 Closing ticket in 5 seconds...', ephemeral: false });
        
        setTimeout(async () => {
          deleteTicket(interaction.channel.id);
          await interaction.channel.delete().catch(() => {});
        }, 5000);
      }
    }
    
    if (interaction.isModalSubmit()) {
      const { customId, guild, user, fields } = interaction;
      const settings = getSettings(guild.id);
      
      if (!settings || !settings.ticket_category || !settings.support_category) {
        return interaction.reply({ content: '❌ Categories not configured. Ask an admin to run /ticketcategory and /supportcategory', ephemeral: true });
      }
      
      let categoryId, ticketType, embedData;
      
      if (customId === 'purchase_modal') {
        categoryId = settings.ticket_category;
        ticketType = 'purchase';
        embedData = {
          buying: fields.getTextInputValue('buying'),
          quantity: fields.getTextInputValue('quantity'),
          payment_method: fields.getTextInputValue('payment_method')
        };
      }
      
      if (customId === 'support_modal') {
        categoryId = settings.support_category;
        ticketType = 'support';
        embedData = {
          help_topic: fields.getTextInputValue('help_topic'),
          explanation: fields.getTextInputValue('explanation')
        };
      }
      
      const channelName = ticketType === 'purchase' 
        ? `purchase-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 20)
        : `support-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 20);
        
      const permissions = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
      ];
      
      if (settings.staff_role) {
        permissions.push({ 
          id: settings.staff_role, 
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] 
        });
      }
      
      try {
        const channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: categoryId,
          permissionOverwrites: permissions
        });
        
        createTicket({
          channel_id: channel.id,
          guild_id: guild.id,
          user_id: user.id,
          type: ticketType,
          buying: embedData.buying || null,
          quantity: embedData.quantity || null,
          payment_method: embedData.payment_method || null,
          help_topic: embedData.help_topic || null,
          explanation: embedData.explanation || null,
          auto_msg_sent: 0
        });
        
        const infoEmbed = new EmbedBuilder()
          .setTitle(ticketType === 'purchase' ? '🛒 Purchase Ticket' : '🎧 Support Ticket')
          .setColor(ticketType === 'purchase' ? 0x5865F2 : 0x57F287)
          .addFields(
            { name: 'User', value: `<@${user.id}> (${user.tag})`, inline: true },
            { name: 'Type', value: ticketType === 'purchase' ? 'Purchase' : 'Support', inline: true },
            { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
          );
          
        if (ticketType === 'purchase') {
          infoEmbed.addFields(
            { name: '📦 What are you buying?', value: embedData.buying, inline: false },
            { name: '🔢 Quantity/Amount', value: embedData.quantity, inline: true },
            { name: '💳 Payment Method', value: embedData.payment_method, inline: true }
          );
        } else {
          infoEmbed.addFields(
            { name: '❓ What do you need help with?', value: embedData.help_topic, inline: false },
            { name: '📝 Explanation', value: embedData.explanation, inline: false }
          );
        }
        
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒')
        );
        
        await channel.send({ content: `<@${user.id}>`, embeds: [infoEmbed], components: [closeRow] });
        
        await interaction.reply({ content: `✅ Your ticket has been created: ${channel}`, ephemeral: true });
        
        if (ticketType === 'purchase') {
          setTimeout(async () => {
            try {
              const ticketCheck = getTicket(channel.id);
              if (ticketCheck && !ticketCheck.auto_msg_sent) {
                const ltcAddress = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
                
                const autoEmbed = new EmbedBuilder()
                  .setTitle('🤖 Bot Helper')
                  .setDescription(`Hello are you here to buy while the owner is offline? I am his Bot Helper, what you can do is send the money to this address if you're paying LTC:

After you sent that, send screenshots and when owner comes he will give you the product as soon as possible.`)
                  .setColor(0xFEE75C)
                  .setTimestamp();
                
                await channel.send({ embeds: [autoEmbed] });
                await channel.send({ content: `📋 **LTC Address (Tap to copy):**\n\`${ltcAddress}\`` });
                
                markAutoMsgSent(channel.id);
              }
            } catch (err) {
              console.error('Auto-msg error:', err);
            }
          }, 10000);
        }
        
      } catch (err) {
        console.error('Ticket creation error:', err);
        await interaction.reply({ content: '❌ Failed to create ticket. Check bot permissions.', ephemeral: true });
      }
    }
    
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: '❌ An error occurred.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ An error occurred.', ephemeral: true }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

client.login(process.env.DISCORD_TOKEN);
