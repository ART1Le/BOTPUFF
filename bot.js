require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  InteractionFlagsBits,
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ====== CONFIG ======
const dataFile = path.resolve(__dirname, 'data.json');
console.log(`[INIT] dataFile path: ${dataFile}`);
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
let userData = {};

// Load data.json
if (fs.existsSync(dataFile)) {
  userData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

// Save data.json
let saveQueued = false;
let saving = false;
function saveData() {
  // Coalesce frequent writes to reduce races
  if (saving) { saveQueued = true; return; }
  saving = true;

  try {
    const dir = path.dirname(dataFile);
    const dirExists = fs.existsSync(dir);
    if (!dirExists) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (mkErr) {
        console.error('[SAVE] mkdir failed:', mkErr.message);
      }
    }

    const tmpPath = path.join(
      dir,
      `data.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    const payload = JSON.stringify(userData, null, 2);
    try {
      console.log(`[SAVE] Writing temp file: ${tmpPath}`);
      fs.writeFileSync(tmpPath, payload, { encoding: 'utf8' });
    } catch (tmpErr) {
      console.error('[SAVE] Temp write failed, falling back to direct write:', tmpErr.message);
      try {
        fs.writeFileSync(dataFile, payload, { encoding: 'utf8' });
        console.log('[SAVE] Direct write OK');
        return;
      } catch (directErr) {
        console.error('[SAVE] Direct write failed:', directErr.message);
        throw directErr; // rethrow to hit outer catch
      }
    }

    try {
      // Try rename first (best-effort atomic)
      fs.renameSync(tmpPath, dataFile);
      console.log('[SAVE] Rename temp -> data.json OK');
    } catch (renameErr) {
      console.warn('[SAVE] Rename failed, trying replace:', renameErr.message);
      try { if (fs.existsSync(dataFile)) fs.rmSync(dataFile, { force: true }); } catch (_) {}
      try {
        fs.renameSync(tmpPath, dataFile);
        console.log('[SAVE] Replace via rename OK');
      } catch (renameErr2) {
        console.warn('[SAVE] Second rename failed, copying:', renameErr2.message);
        try { fs.copyFileSync(tmpPath, dataFile); } finally {
          try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
        }
        console.log('[SAVE] Copy fallback OK');
      }
    }
  } catch (err) {
    console.error('Gagal menyimpan data.json:', err.message);
  } finally {
    saving = false;
    if (saveQueued) {
      saveQueued = false;
      // slight delay to let FS settle on Windows
      setTimeout(() => saveData(), 25);
    }
  }
}

// Helper functions
function isAdmin(userId) {
  return process.env.ADMIN_IDS.split(',').includes(userId);
}

async function safeSend(channel, payload, delay = 2500) {
  try {
    await channel.send(payload);
    await new Promise(r => setTimeout(r, delay));
  } catch (err) {
    console.error('Gagal kirim pesan:', err);
  }
}

// ====== FETCH NICKNAME ROBLOX ======
async function fetchNicknameRealtime(username, retry = 0) {
  try {
    const res = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username],
      excludeBannedUsers: false
    });

    if (!res.data.data || res.data.data.length === 0) return null;

    const userId = res.data.data[0].id;
    const displayName = res.data.data[0].displayName;

    const avatarRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`);
    const avatarUrl = avatarRes.data.data[0].imageUrl;

    return { userId, displayName, avatarUrl };
  } catch (err) {
    if (err.response?.data?.errors?.[0]?.code === 4 && retry < 5) {
      console.log(`⚠️ Rate limit hit untuk ${username}, retry ke-${retry + 1}...`);
      await new Promise(r => setTimeout(r, 3000));
      return fetchNicknameRealtime(username, retry + 1);
    }
    console.error(`Fetch error ${username}:`, err.response?.data || err.message);
    return null;
  }
}

// ====== AUTO REFRESH SEMUA USERNAME ======
async function autoRefreshAll() {
  // Report member yang displayName-nya tidak mengandung 'PUFF'
  if (process.env.REPORT_CHANNEL_ID) {
    const channel = client.channels.cache.get(process.env.REPORT_CHANNEL_ID);
    if (channel) {
      const notPuffMembers = Object.entries(userData)
        .filter(([username, obj]) => obj.displayName && !/puff/i.test(obj.displayName))
        .map(([username, obj]) => ({ username, displayName: obj.displayName, discordId: obj.discordId }));
      if (notPuffMembers.length > 0) {
        const lines = notPuffMembers.map(m => `⚠️ **${m.displayName}** | ${m.username} <@${m.discordId}>`);
        // Pastikan panjang lines tidak melebihi 4096 karakter
        const reportText = lines.join('\n');
        const chunks = [];
        for (let i = 0; i < reportText.length; i += 4000) {
          chunks.push(reportText.slice(i, i + 4000));
        }
        for (const chunk of chunks) {
          const embed = new EmbedBuilder()
            .setTitle('🚨 Member tanpa "PUFF" di displayName')
            .setDescription(chunk)
            .setColor(0xFF0000)
            .setTimestamp();
          try { await channel.send({ embeds: [embed] }); }
          catch (err) { console.error('Gagal kirim laporan member tanpa PUFF:', err); }
        }
      }
    }
  }
  console.log('⏳ Mengecek semua username...');
  const changedUsers = [];
  const usernames = Object.keys(userData);
  if (usernames.length === 0) {
    console.log('⚠️ Tidak ada username untuk dicek.');
    return;
  }

  const batchSize = 10;
  for (let i = 0; i < usernames.length; i += batchSize) {
    const batch = usernames.slice(i, i + batchSize);
    for (const username of batch) {
      const oldNick = userData[username]?.displayName || "";
      const nickData = await fetchNicknameRealtime(username);
      if (nickData && oldNick !== nickData.displayName) {
        changedUsers.push({ username, oldNick, newNick: nickData.displayName });
        userData[username].displayName = nickData.displayName;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  saveData();

  if (changedUsers.length > 0 && process.env.REPORT_CHANNEL_ID) {
    const channel = client.channels.cache.get(process.env.REPORT_CHANNEL_ID);
    if (channel) {
      const reportList = changedUsers.map(u => `🔄 **${u.username}**: \`${u.oldNick}\` → \`${u.newNick}\``).join('\n');
      // Pastikan panjang reportList tidak melebihi 4096 karakter
      const chunks = [];
      for (let i = 0; i < reportList.length; i += 4000) {
        chunks.push(reportList.slice(i, i + 4000));
      }
      for (const chunk of chunks) {
        const embed = new EmbedBuilder()
          .setTitle('📢 Nih yang ganti Nickname')
          .setDescription(chunk)
          .setColor(0x2F3136)
          .setTimestamp();
        try { await channel.send({ embeds: [embed] }); } 
        catch (err) { console.error('Gagal kirim laporan nickname:', err); }
      }
    }
  }

  console.log('✅ Auto-refresh selesai.');
}

// ====== SLASH COMMANDS ======
const commands = [
  new SlashCommandBuilder()
    .setName('listmemberspuff')
    .setDescription('Menampilkan list member PUFF dan tag Discord jika displayName tidak mengandung "PUFF"'),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Menambah Username Member PUFF')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Username Roblox').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('discordid').setDescription('Discord ID (wajib, contoh: 123456789012345678)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('cekusername')
    .setDescription('Cek username Roblox')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Username Roblox').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('announc')
    .setDescription('Buat ANNOUNCEMENT')
    .addStringOption(opt =>
      opt.setName('channelid').setDescription('ID channel tujuan').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('text').setDescription('Isi pengumuman').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('title').setDescription('Judul pengumuman').setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('pinghere').setDescription('Mention @here?').setRequired(false)
    )
    .addRoleOption(opt =>
      opt.setName('roleping').setDescription('Role yang ingin di-mention').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('imageurl').setDescription('Link gambar pengumuman').setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('polling').setDescription('Jadikan pengumuman polling?').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('polloptions').setDescription('Opsi polling dipisah koma, misal: Ya,Tidak,Mungkin').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('duration').setDescription('Durasi polling dalam detik (default 60)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('deleteusn')
    .setDescription('Hapus 1 username')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Username Roblox').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('resetdatamember')
    .setDescription('Reset semua data member (ADMIN ONLY)')
].map(cmd => cmd.toJSON());


// Register commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log('⏳ Refreshing slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Error register commands:', err);
  }
})();

// ====== HANDLE SLASH COMMANDS ======
client.on('interactionCreate', async (interaction) => {
  // Inisialisasi variabel utama di awal agar tidak ReferenceError
  if (!interaction.isChatInputCommand()) return;
  const commandName = interaction.commandName;
  const options = interaction.options;
  const user = interaction.user;
  const guild = interaction.guild;

  // === /listmemberspuff ===
  if (commandName === 'listmemberspuff') {
    if (!isAdmin(user.id)) return interaction.reply({ content: '⛔ Lu gaboleh make command ini.', ephemeral: true });
    const usernames = Object.keys(userData);
    if (usernames.length === 0) return interaction.reply({ content: '⚠️ Data masih kosong.', ephemeral: true });

    const updatedMembers = [];
    const notPuffMembers = [];

    for (const username of usernames) {
      const obj = userData[username];
      updatedMembers.push({ username, displayName: obj.displayName, discordId: obj.discordId });
      if (!/puff/i.test(obj.displayName)) {
        notPuffMembers.push({ username, displayName: obj.displayName, discordId: obj.discordId });
      }
    }

    // urutkan biar rapi
    updatedMembers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    // tampilkan chunk 25 per-embed
    const CHUNK_SIZE = 25;
    for (let i = 0; i < updatedMembers.length; i += CHUNK_SIZE) {
      const chunk = updatedMembers.slice(i, i + CHUNK_SIZE);
      const descLines = chunk.map(m => `**${m.displayName}** | ${m.username}`);
      const embed = new EmbedBuilder()
        .setTitle('📋 List Member PUFF')
        .setDescription(descLines.join('\n'))
        .setColor(0x2F3136)
        .setTimestamp()
        .setFooter({ text: `Menampilkan ${i + 1}-${i + chunk.length} dari ${updatedMembers.length} Member PUFF` });
      await interaction.channel.send({ embeds: [embed] });
    }

    // mention/tag semua discordId yang tidak ada "PUFF"
    if (notPuffMembers.length > 0) {
      const mentionList = notPuffMembers.map(m => `<@${m.discordId}>`).join(' ');
      const lines = notPuffMembers.map(m => `⚠️ **${m.displayName}** | ${m.username}`);
      // Pastikan panjang lines tidak melebihi 4096 karakter
      const reportText = lines.join('\n');
      const chunks = [];
      for (let i = 0; i < reportText.length; i += 4000) {
        chunks.push(reportText.slice(i, i + 4000));
      }
      for (const chunk of chunks) {
        const embed = new EmbedBuilder()
          .setTitle('🚨 Member tanpa Nickname "PUFF"')
          .setDescription(chunk)
          .setColor(0xFF0000)
          .setTimestamp();
        await interaction.channel.send({ content: mentionList, embeds: [embed] });
      }
    }

    await interaction.reply({ content: `✅ List member PUFF sudah ditampilkan.`, ephemeral: true });
  }
  async function safeReply(payload) {
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp(payload);
    } else {
      return interaction.reply(payload);
    }
  }

  // === /add ===
    if (commandName === 'add') {
      if (!isAdmin(user.id)) return safeReply({ content: '⛔ Lu gaboleh make command ini.' });
      const username = options.getString('username');
      const discordid = options.getString('discordid');
        // Validasi format username Roblox
        if (!username || !discordid) return safeReply({ content: '❌ Format salah. Wajib isi username roblox dan discord ID.' });
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          return safeReply({ content: '❌ Format username Roblox tidak valid. Hanya huruf, angka, dan underscore, 3-20 karakter.' });
        }
        // Validasi format Discord ID
        if (!/^[0-9]{17,20}$/.test(discordid)) {
          return safeReply({ content: '❌ Format Discord ID tidak valid. Harus angka 17-20 digit.' });
        }
        if (userData[username]) return safeReply({ content: `⚠️ Username **${username}** udah terdaftar sebagai **${userData[username].displayName}**.` });

        await interaction.deferReply({ ephemeral: false });
        const nickData = await fetchNicknameRealtime(username);
        if (!nickData || !nickData.userId || !nickData.displayName) {
          return safeReply({ content: `❌ Username **${username}** tidak ditemukan (cek yang bener ah).` });
        }

        userData[username] = {
          displayName: nickData.displayName,
          discordId: discordid
        };
        saveData();
        return safeReply({ content: `🎉 Username **${username}** dengan Nickname **${nickData.displayName}** dan berhasil ditambahkan sebagai OFFICIAL MEMBER PUFF! Welcome <@${discordid}> jangan lupa berbaur ya sama yang lain ya 🐣 We hope you feel comfortable here with us.` });
    }

  // === CEK USERNAME ===
if (commandName === 'cekusername') {
  const username = options.getString('username');
  await interaction.deferReply({ ephemeral: false });

  const nickData = await fetchNicknameRealtime(username);
  if (!nickData) return safeReply({ content: `❌ Username **${username}** tidak ditemukan.` });

  // =========================
  // Status & Game
  // =========================
  let status = '⚪ Offline / Tidak bermain saat ini';
  let gameName = null;
  let joinURL = null;

  try {
    const presenceRes = await axios.get(`https://presence.roblox.com/v1/presence/users/${nickData.userId}`);
    const presence = presenceRes.data.userPresenceType; // 0=Offline,1=Online,2=In Studio,3=In Game
    if (presence === 1) status = '🟢 Online';
    if (presence === 2 || presence === 3) {
      const lastPlaceId = presenceRes.data.gameId;
      if (lastPlaceId) {
        gameName = presenceRes.data.placeName;
        joinURL = `https://www.roblox.com/games/${lastPlaceId}`;
        status = `🟢 Sedang bermain: **${gameName}**`;
      }
    }
  } catch (err) {
    console.error('Fetch presence error:', err.message);
  }

  // =========================
  // Friends / Followers
  // =========================
  let friendsCount = 0, followersCount = 0;
  try {
    const friendsRes = await axios.get(`https://friends.roblox.com/v1/users/${nickData.userId}/friends/count`);
    friendsCount = friendsRes.data.count || 0;
    const followersRes = await axios.get(`https://friends.roblox.com/v1/users/${nickData.userId}/followers/count`);
    followersCount = followersRes.data.count || 0;
  } catch (err) {
    console.error('Fetch friends/followers error:', err.message);
  }

  // =========================
  // Embed Dinamis
  // =========================
  const color = parseInt(username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0).toString().slice(-6), 10) || 0x00FFFF;

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Info Player : ${nickData.displayName}`)
    .setDescription(
      `**Username:** ${username}\n` +
      `**UserID:** ${nickData.userId}\n` +
      `**Status:** ${status}\n` +
      `**Friends:** ${friendsCount}\n` +
      `**Followers:** ${followersCount}`
    )
    .setThumbnail(nickData.avatarUrl)
    .setColor(color)
    .setTimestamp();

  // =========================
  // Tombol Interaktif
  // =========================
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Lihat Profil')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.roblox.com/users/${nickData.userId}/profile`),
    new ButtonBuilder()
      .setLabel(joinURL ? 'Join Map' : 'Sedang tidak ada map manapun')
      .setStyle(ButtonStyle.Link)
      .setURL(joinURL || 'https://www.roblox.com/')
      .setDisabled(!joinURL)
  );

  return safeReply({ embeds: [embed], components: [buttons] });
}

  if (commandName === 'announc') {
  if (!isAdmin(user.id)) {
    return safeReply({ content: '⛔ Lu gaboleh make command ini.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const channelId = options.getString('channelid');
  const rawText = options.getString('text');
  const title = options.getString('title') || '📢 ANNOUNCEMENT';
  const pingHere = options.getBoolean('pinghere') ?? false;
  const rolePing = options.getRole('roleping');
  const imageUrl = options.getString('imageurl');
  const isPolling = options.getBoolean('polling') ?? false;
  const pollOptionsStr = options.getString('polloptions') || '';
  const duration = options.getInteger('duration') || 60;

  const targetChannel = guild.channels.cache.get(channelId);
  if (!targetChannel) {
    return interaction.editReply({ content: '❌ Channel tidak ditemukan.' });
  }

  const description = rawText.replace(/\\n/g, '\n');
  const mentionString = rolePing ? `<@&${rolePing.id}>` : (pingHere ? '@here' : null);

  if (isPolling) {
    // Parse opsi polling
    const pollOptions = pollOptionsStr.split(',').map(opt => opt.trim()).filter(opt => opt.length > 0);

    if (pollOptions.length === 0) {
      return interaction.editReply({
        content: '❌ Polling harus memiliki minimal satu opsi, gunakan opsi polloptions dengan value dipisah koma.'
      });
    }
    if (pollOptions.length > 5) {
      return interaction.editReply({
        content: '❌ Maksimal 5 opsi polling untuk kemudahan voting.'
      });
    }

    // Buat baris tombol polling
    const buttons = new ActionRowBuilder();
    pollOptions.forEach((opt, idx) => {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(`poll_${idx}`)
          .setLabel(opt)
          .setStyle(ButtonStyle.Primary)
      );
    });

    // Kirim pesan polling
    const pollEmbed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description + '\n\nVote sekarang dengan menekan tombol di bawah.')
      .setColor(0xE91E63)
      .setTimestamp()
      .setFooter({ text: `Polling berakhir dalam ${duration} detik.` });

    const pollMessage = await targetChannel.send({
      content: mentionString,
      embeds: [pollEmbed],
      components: [buttons]
    });

    const votes = new Map();

    const collector = pollMessage.createMessageComponentCollector({ time: duration * 1000 });

    collector.on('collect', async i => {
      votes.set(i.user.id, parseInt(i.customId.split('_')[1], 10));
      await i.deferUpdate();
    });

    collector.on('end', async () => {
      const resultsCount = new Array(pollOptions.length).fill(0);
      for (const optionIndex of votes.values()) {
        if (optionIndex >= 0 && optionIndex < pollOptions.length) resultsCount[optionIndex]++;
      }

      let resultDesc = '';
      pollOptions.forEach((opt, idx) => {
        resultDesc += `**${opt}**: ${resultsCount[idx]} suara\n`;
      });

      const resultEmbed = new EmbedBuilder()
        .setTitle(`📊 Hasil Polling: ${title}`)
        .setDescription(resultDesc)
        .setColor(0x00FF00)
        .setTimestamp()
        .setFooter({ text: `Polling berakhir setelah ${duration} detik.` });

      // Matikan tombol setelah polling selesai
      const disabledRow = new ActionRowBuilder();
      buttons.components.forEach(btn => {
        btn.setDisabled(true);
        disabledRow.addComponents(btn);
      });

      await pollMessage.edit({ embeds: [resultEmbed], components: [disabledRow] });
    });

    await interaction.editReply({ content: '✅ Polling terkirim dan berjalan!' });

  } else {
    // Pengumuman biasa
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0xE91E63)
      .setTimestamp()
      .setFooter({ text: 'Best regards,\nPUFF Entertainment' });

    if (imageUrl && /\.(jpg|jpeg|png|gif|webp)$/i.test(imageUrl)) {
      embed.setImage(imageUrl);
    }

    await targetChannel.send({ content: mentionString, embeds: [embed] });
    await interaction.editReply({ content: '✅ Pengumuman terkirim!' });
  }
}

  // === /deleteusn ===
  if (commandName === 'deleteusn') {
    if (!isAdmin(user.id)) return safeReply({ content: '⛔ Lu gaboleh make command ini.' });
    const username = options.getString('username');
     const userObj = userData[username];
     if (!userObj) return safeReply({ content: `❌ Username **${username}** tidak ada di database.` });

     const displayName = userObj.displayName || username;
     delete userData[username];
     saveData();
     return safeReply({ content: `✅ Username **${username}** dengan Nickname **${displayName}** berhasil dihapus. Discord : <@${userObj.discordId}>` });
  }

  // === /resetdatamember ===
  if (commandName === 'resetdatamember') {
    if (!isAdmin(user.id)) return safeReply({ content: '⛔ Lu gaboleh make command ini.' });
    userData = {};
    saveData();
    return safeReply({ content: '✅ Semua data member PUFF berhasil direset.' });
  }
});

// ====== START BOT ======
client.once('ready', () => {
  console.log(`🤖 Bot Member PUFF siap sebagai ${client.user.tag}`);
  autoRefreshAll();
  // Jalankan autoRefreshAll setiap 120 menit (2 jam)
  const intervalMinutes = 120;
  setInterval(() => {
    console.log(`⏳ Interval: Mengecek semua username (setiap ${intervalMinutes} menit)`);
    autoRefreshAll();
  }, intervalMinutes * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
