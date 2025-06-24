const http = require('http');
const { Client, SpotifyRPC } = require('discord.js-selfbot-v13');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
require('dotenv').config({ path: `${__dirname}/.env` });

// HTTPサーバー（ヘルスチェック用）
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
});
server.listen(process.env.PORT || 8080, () => {
  console.log(`[INFO] HTTP server running on port ${process.env.PORT || 8080}`);
});

// 環境変数の確認
const requiredEnv = ['DISCORD_TOKEN', 'GOOGLE_AI_KEY', 'GUILD_ID', 'ALLOWED_CHANNEL_ID', 'RESTRICTED_CHANNEL_ID'];
for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`[FATAL] エラー: .envファイルに${env}が定義されていません。`);
    process.exit(1);
  }
}
console.log('[DEBUG] 環境変数:', {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ? '読み込み成功' : 'undefined',
  GOOGLE_AI_KEY: process.env.GOOGLE_AI_KEY ? '読み込み成功' : 'undefined',
  GUILD_ID: process.env.GUILD_ID ? '読み込み成功' : 'undefined',
  ALLOWED_CHANNEL_ID: process.env.ALLOWED_CHANNEL_ID ? '読み込み成功' : 'undefined',
  RESTRICTED_CHANNEL_ID: process.env.RESTRICTED_CHANNEL_ID ? '読み込み成功' : 'undefined',
});

// ボットの設定
const client = new Client({ checkUpdate: false, syncStatus: false });
const prefix = 'y!';
const DELETE_DELAY = 5000;
const COOLDOWN_TIME = 5000;
const SPAM_THRESHOLD = 3;
const SPAM_COOLDOWN = 10000;
const cooldowns = new Map();
const commandHistories = new Map();
const largeImageId = 'ab67706c0000da84ce73f513454cb93faeffc4ac';

// Gemini APIのセットアップ
let genAI, model;
try {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);
  model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  console.log('[INFO] Google Gemini AI初期化成功');
} catch (error) {
  console.error('[ERROR] Google Gemini AI初期化失敗:', error.message);
}

// Anilist API用のGraphQLクエリ
const ANILIST_QUERY = `
  query ($search: String) {
    Media (search: $search, type: ANIME) {
      title { romaji, english }
      description
      coverImage { large }
      averageScore
      episodes
    }
  }
`;

// エラーログ関数
const logError = (command, input, error, apiResponse, additionalInfo = {}) => {
  console.error(
    `[${new Date().toISOString()}] ${command} Error:`,
    `\nInput: ${input || 'N/A'}`,
    `\nMessage: ${error.message}`,
    `\nAPI Response: ${JSON.stringify(apiResponse, null, 2) || 'N/A'}`,
    `\nAdditional Info: ${JSON.stringify(additionalInfo, null, 2) || 'N/A'}`,
    `\nStack: ${error.stack}`
  );
};

// Spotifyステータス設定
function setSpotifyStatus(client) {
  const spotify = new SpotifyRPC(client)
    .setAssetsLargeImage(`spotify:${largeImageId}`)
    .setAssetsSmallImage('spotify:ab6761610000f178049d8aeae802c96c8208f3b7')
    .setAssetsLargeText('おかえり のんのんびより')
    .setState('宮内れんげ(小岩井ことり)')
    .setDetails('おかえり のんのんびより')
    .setStartTimestamp(Date.now())
    .setEndTimestamp(Date.now() + 1000 * (5 * 60 + 31))
    .setSongId('3zmCyWGe2griKG51XTFDXU')
    .setAlbumId('3hvf777K6J1tG1xR9r5SYR')
    .setArtistIds(['0ylRpgFg2vbA9ErHKPKMb8']);
  client.user.setActivity(spotify);
  console.log('[INFO] Spotify風ステータスを設定しました！');
}

// ステータスループ
function startStatusLoop(client) {
  const duration = 1000 * (5 * 60 + 31);
  setSpotifyStatus(client);
  setInterval(() => {
    setSpotifyStatus(client);
    console.log('[INFO] ステータスをリピートしました');
  }, duration);
}

// 応答を20行以内に要約
function summarizeResponse(response) {
  const lines = response.split('\n').filter(line => line.trim());
  if (lines.length > 20) {
    console.log('[DEBUG] 応答を20行以内に要約');
    return lines.slice(0, 19).join('\n') + '\n…続きは省略いたします';
  }
  return response;
}

// ロールプレイ要素を適用
function applyRoleplay(response, userInput) {
  console.log('[DEBUG] ロールプレイ適用後の応答:', response);
  return response;
}

// 送信遅延
const sendWithDelay = async (message, content, isFallback = false, retryCount = 0) => {
  try {
    const permissions = message.channel.type === 'DM' ? { send: true } : {
      send: message.channel.permissionsFor(client.user)?.has('SEND_MESSAGES') || false,
    };
    if (!permissions.send) throw new Error('Missing SEND_MESSAGES permission');
    const sentMessage = await new Promise(resolve => setTimeout(() => resolve(message.channel.send(content)), 3000));
    console.log(`[${new Date().toISOString()}] Sent ${isFallback ? 'fallback' : 'content'}: ${content.substring(0, 200)}`);
    return sentMessage;
  } catch (error) {
    if (retryCount < 2) return sendWithDelay(message, content, isFallback, retryCount + 1);
    logError('SendWithDelay', 'N/A', error, null, { content: content.substring(0, 200), channel: message.channel.id });
    return null;
  }
};

// 処理中メッセージ
const sendProcessingMessage = async (message, content) => {
  try {
    const permissions = message.channel.type === 'DM' ? { send: true } : {
      send: message.channel.permissionsFor(client.user)?.has('SEND_MESSAGES') || false,
    };
    if (!permissions.send) throw new Error('Missing SEND_MESSAGES permission');
    const processingMessage = await message.channel.send(content);
    console.log(`[${new Date().toISOString()}] Sent processing message: ${content}`);
    return processingMessage;
  } catch (error) {
    logError('ProcessingMessage', 'N/A', error, null, { channel: message.channel.id });
    return null;
  }
};

const deleteProcessingMessage = async (processingMessage) => {
  if (processingMessage) {
    try {
      await processingMessage.delete();
      console.log(`[${new Date().toISOString()}] Deleted processing message`);
    } catch (error) {
      logError('DeleteProcessingMessage', 'N/A', error, null);
    }
  }
};

// ボット準備
client.once('ready', () => {
  console.log(`[${new Date().toISOString()}] ユーザー: ${client.user.tag} (ID: ${client.user.id}) 起動完了 - ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST`);
  console.log(`対象サーバー: ${process.env.GUILD_ID || '未設定（DM対応）'}`);
  console.log('取得したLarge Image ID:', largeImageId);
  startStatusLoop(client);
});

// メッセージ処理
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  console.log(`メッセージ受信: "${message.content}" from ${message.author.tag} (ID: ${message.author.id}) in guild: ${message.guild?.id || 'DM'}`);

  // サーバーチェック
  if (message.guild && message.guild.id !== process.env.GUILD_ID) {
    console.log(`サーバーID不一致: ${message.guild.id} !== ${process.env.GUILD_ID}、無視`);
    return;
  }

  // 許可チャンネルチェック
  if (message.channel.id !== process.env.ALLOWED_CHANNEL_ID && message.channel.type !== 'DM') {
    console.log(`許可されていないチャンネル: ${message.channel.id}、無視`);
    return;
  }

  // 禁止チャンネル
  if (message.channel.id === process.env.RESTRICTED_CHANNEL_ID) {
    const restrictedMessage = await sendWithDelay(message, [
      `⚠️ 禁止チャンネル ⚠️`,
      `このチャンネルではコマンドは使えません！ 😔`,
    ].join('\n'), true);
    if (restrictedMessage) {
      setTimeout(async () => {
        try {
          await restrictedMessage.delete();
          console.log(`[${new Date().toISOString()}] Deleted restricted message`);
        } catch (error) {
          logError('DeleteRestricted', 'N/A', error, null);
        }
      }, DELETE_DELAY);
    }
    return;
  }

  const args = message.content.toLowerCase().startsWith(prefix) ? message.content.slice(prefix.length).trim().split(/ +/) : [];
  const command = args.shift()?.toLowerCase() || '';

  // メンション・リプライチェック
  let userInput = '';
  let isChatCommand = command === 'chat';
  let isMention = message.mentions.has(client.user);
  let isReplyToBot = false;

  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage.author.id === client.user.id) isReplyToBot = true;
    } catch (error) {
      logError('FetchReply', 'N/A', error, null);
    }
  }

  if (isChatCommand || isMention || isReplyToBot) {
    if (isChatCommand) {
      userInput = args.join(' ').trim();
      console.log('[DEBUG] y!chatコマンド検出、入力:', userInput);
    } else if (isMention || isReplyToBot) {
      userInput = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      console.log(`[DEBUG] ${isMention ? 'メンション' : 'リプライ'}検出、入力:`, userInput);
    }
    if (!userInput && (isMention || isReplyToBot)) {
      await sendWithDelay(message, '何かお話ししてください！', true);
      return;
    }
  } else if (!command) {
    console.log('[DEBUG] コマンド、メンション、リプライでないため無視');
    return;
  }

  // スパムチェック
  const userId = message.author.id;
  const now = Date.now();
  let history = commandHistories.get(userId) || [];
  history = history.filter(timestamp => now - timestamp < 5000);
  history.push(now);
  commandHistories.set(userId, history);

  if (history.length >= SPAM_THRESHOLD) {
    const cooldownTimestamp = cooldowns.get(userId);
    if (!cooldownTimestamp || now >= cooldownTimestamp) {
      await sendWithDelay(message, `<@${userId}> さん、スパムはやめてくださいよ～💦`, true);
      cooldowns.set(userId, now + SPAM_COOLDOWN);
      console.log(`[${new Date().toISOString()}] ユーザー ${userId} がスパム検知、クールダウン設定`);
      return;
    }
  }

  // 通常のレート制限
  const cooldownTimestamp = cooldowns.get(userId);
  if (cooldownTimestamp && now < cooldownTimestamp) {
    const timeLeft = ((cooldownTimestamp - now) / 1000).toFixed(1);
    await sendWithDelay(message, `⏰ クールダウン中 ⏰\nあと ${timeLeft}秒待ってください！`, true);
    return;
  }
  cooldowns.set(userId, now + COOLDOWN_TIME);

  // チャット処理
  if (isChatCommand || isMention || isReplyToBot) {
    let processingMessage = await sendProcessingMessage(message, '💬 応答生成中... 💬');
    try {
      const canReact = message.channel.type === 'DM' || (message.channel.permissionsFor(client.user)?.has('ADD_REACTIONS')) || false;
      if (canReact) {
        await message.react('😺');
        console.log('ユーザーメッセージにリアクション😺を追加');
      } else {
        console.log('リアクション権限がないため、😺リアクションをスキップ');
      }
      await message.channel.sendTyping();
      console.log('入力中表示を開始');

      const history = chatHistories.get(userId) || [];
      chatHistories.set(userId, history);

      const prompt = `以下の指示に従ってください：
1. 必ず日本語で応答してください。
2. 応答内容を15行以内にしてください。
ユーザーの入力: ${userInput}`;

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(prompt);
      let response = await result.response.text();
      console.log(`Gemini応答: ${response}`);

      response = summarizeResponse(response);
      response = applyRoleplay(response, userInput);

      const chunks = response.match(/.{1,2000}/g) || [response];
      await deleteProcessingMessage(processingMessage);
      for (const chunk of chunks) {
        await sendWithDelay(message, chunk);
      }

      history.push(
        { role: 'user', parts: [{ text: userInput }] },
        { role: 'model', parts: [{ text: response }] }
      );
      if (history.length > 20) history.splice(0, 2);
    } catch (error) {
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, `😿 エラー 😿\n応答生成に失敗しました: ${error.message}`, true);
      logError('Chat', userInput, error, null);
    }
    return;
  }

  // 猫画像
  if (command === 'cat') {
    let processingMessage = await sendProcessingMessage(message, '🐾 猫画像を取得中... 🐾');
    try {
      const response = await axios.get('https://api.thecatapi.com/v1/images/search');
      const catData = response.data[0];
      if (!catData?.url) throw new Error('No valid image URL');
      await axios.head(catData.url);
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, `🐾 ランダムな猫の画像 😺\n${catData.url}`);
    } catch (error) {
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, `😿 エラー 😿\n猫画像の取得に失敗しました！`, true);
      logError('Cat API', 'N/A', error, null);
    }
  }

  // アニメ情報
  if (command === 'anime') {
    const searchQuery = args.join(' ').trim();
    if (!searchQuery) {
      await sendWithDelay(message, `🎬 アニメ検索エラー 🎬\nタイトルを指定してください！（例: y!anime Demon Slayer）`, true);
      return;
    }
    let processingMessage = await sendProcessingMessage(message, '🎬 アニメ情報を取得中... 🎬');
    try {
      const response = await axios.post('https://graphql.anilist.co', {
        query: ANILIST_QUERY,
        variables: { search: searchQuery },
      });
      const anime = response.data.data.Media;
      if (!anime) throw new Error('No anime found');
      const content = [
        `🎬 アニメ: ${anime.title.english || anime.title.romaji || '不明'} 🎬`,
        `ローマ字: ${anime.title.romaji || 'N/A'}`,
        `説明: ${anime.description ? anime.description.replace(/<[^>]+>/g, '').slice(0, 200) + '...' : 'なし'}`,
        `スコア: ${anime.averageScore || 'N/A'}/100`,
        `エピソード: ${anime.episodes || 'N/A'}`,
        `画像: ${anime.coverImage.large || 'なし'}`,
      ].join('\n');
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, content);
    } catch (error) {
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, `🎬 エラー 🎬\nアニメ情報の取得に失敗しました！`, true);
      logError('Anilist API', searchQuery, error, null);
    }
  }

  // ポケモン情報
  if (command === 'pokemon') {
    const pokemonName = args.join('-').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
    if (!pokemonName) {
      await sendWithDelay(message, `⚡ ポケモン検索エラー ⚡\n名前を指定してください！（例: y!pokemon Pikachu）`, true);
      return;
    }
    let processingMessage = await sendProcessingMessage(message, '⚡ ポケモン情報を取得中... ⚡');
    try {
      const response = await axios.get(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
      const pokemon = response.data;
      const spriteUrl = pokemon.sprites.front_default;
      if (spriteUrl) await axios.head(spriteUrl);
      const content = [
        `⚡ ポケモン: ${pokemon.name.charAt(0).toUpperCase() + pokemon.name.slice(1)} #${pokemon.id} ⚡`,
        `タイプ: ${pokemon.types.map(t => t.type.name).join(', ')}`,
        `高さ: ${pokemon.height / 10} m`,
        `重さ: ${pokemon.weight / 10} kg`,
        `スプライト: ${spriteUrl || 'なし'}`,
      ].join('\n');
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, content);
    } catch (error) {
      await deleteProcessingMessage(processingMessage);
      await sendWithDelay(message, `⚡ エラー ⚡\n"${pokemonName}" に該当するポケモンが見つかりませんでした！`, true);
      logError('PokéAPI', pokemonName, error, null);
    }
  }
});

// エラーハンドリング
client.on('error', error => logError('Client', 'N/A', error, null));

// プロセスエラーハンドリング
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
});

process.on('warning', (warning) => {
  console.warn('[WARNING]', warning);
});

process.on('SIGTERM', () => {
  console.log('[INFO] SIGTERM received. Closing client...');
  client.destroy();
  server.close();
  process.exit(0);
});

// プロセスを維持するためのハートビートログ
setInterval(() => {
  console.log('[INFO] プロセス稼働中:', new Date().toISOString());
}, 60000);

// ボットログイン
client.login(process.env.DISCORD_TOKEN).catch(error => {
  logError('Login', 'N/A', error, null);
  console.error('エラー詳細:', JSON.stringify(error, null, 2));
  process.exit(1);
});
