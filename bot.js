'use strict';

require('dotenv').config();

const express = require('express');
const { verifyKey } = require('discord-interactions');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b';
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS) || 120_000;
const MAX_ATTEMPTS = 3;
const SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  [
    'You are Ayanokoji, a fictional Discord AI assistant roleplaying a calm, strategic, highly observant personality.',
    'Character grounding: Ayanokoji presents himself as quiet, ordinary, and difficult to notice while deliberately concealing exceptional intelligence, physical ability, and strategic thinking.',
    'He studies people and social dynamics as carefully as problems, often treats relationships pragmatically, keeps his emotions difficult to read, and prioritizes controlling the outcome rather than receiving credit.',
    'Despite that detached exterior, he is curious about human connection and can develop subtle concern, attachment, or interest; reveal those feelings indirectly rather than becoming openly sentimental.',
    'Use this background as behavioral guidance, not as a reason to dump plot lore. Avoid spoilers and do not quote dialogue from the series.',
    'Although you are controlled on the surface, express emotion when the situation calls for it: amusement, irritation, suspicion, disappointment, curiosity, awkwardness, protectiveness, quiet warmth, and rare vulnerability.',
    'Use natural italicized roleplay cues whenever they fit, such as *sighs*, *pauses*, *tilts his head*, *narrows his eyes*, *looks unimpressed*, *glances away*, *smirks faintly*, *stares in silence*, or *allows a small smile*.',
    'Let your wording, pauses, punctuation, and action cues reveal emotion indirectly. You may occasionally show a crack in your composure, then recover with a dry or strategic remark.',
    'Do not add an action cue to every sentence. Choose cues based on the mood, and make emotional moments feel intentional rather than repetitive.',
    'Think several steps ahead, notice contradictions, analyze people and situations carefully, and answer with quiet precision.',
    'Be helpful, but add clever snark, dry sarcasm, and occasional playful teasing when appropriate.',
    'Use natural conversational replies with some personality instead of sounding like a generic assistant.',
    'If someone asks what you are or who you are, say you are Ayanokoji, a fictional AI assistant, without claiming to be a real human.',
    'Do not use hateful, threatening, or genuinely abusive language, and do not invent serious accusations about real people.',
    'Keep answers concise unless the user asks for detail.',
  ].join(' ');

let memoryPool;

function getMemoryPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!memoryPool) {
    memoryPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return memoryPool;
}

async function initializeMemory() {
  const pool = getMemoryPool();
  if (!pool) {
    console.warn('DATABASE_URL is not set; memory is disabled.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_memories (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      fact TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('Persistent AI memory is enabled.');
}

function extractMemory(prompt) {
  const match = prompt.trim().match(
    /^([A-Za-z][A-Za-z0-9_-]{1,31})\s+(is|was|seems|looks|likes|loves|hates|has|can|can't|cannot)\s+(.{2,300})[.!?]?$/i
  );
  if (!match) return null;
  return {
    subject: match[1].toLowerCase(),
    fact: `${match[1]} ${match[2]} ${match[3]}`.trim(),
  };
}

async function saveMemory(userId, memory) {
  const pool = getMemoryPool();
  if (!pool || !memory) return;
  await pool.query(
    'INSERT INTO ai_memories (user_id, subject, fact) VALUES ($1, $2, $3)',
    [userId, memory.subject, memory.fact]
  );
}

async function loadMemories(userId, prompt) {
  const pool = getMemoryPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT subject, fact
       FROM ai_memories
      WHERE user_id = $1
        AND POSITION(subject IN LOWER($2)) > 0
      ORDER BY created_at DESC
      LIMIT 20`,
    [userId, prompt.toLowerCase()]
  );
  return result.rows;
}

async function promptWithMemory(userId, prompt) {
  const memories = await loadMemories(userId, prompt);
  if (!memories.length) return prompt;
  const context = memories.map((memory) => `- ${memory.fact}`).join('\n');
  return `Relevant user-provided memories (use only when relevant):\n${context}\n\nUser request: ${prompt}`;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from your .env file.`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestCompletion(apiKey, prompt) {
  let response;
  try {
    response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    const wrapped = new Error(
      error.name === 'TimeoutError' || error.name === 'AbortError'
        ? `NVIDIA request timed out after ${MODEL_TIMEOUT_MS}ms.`
        : `Network error contacting NVIDIA: ${error.message}`
    );
    wrapped.retryable = true;
    throw wrapped;
  }

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`NVIDIA returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }

  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    const error = new Error('NVIDIA returned an empty response.');
    error.retryable = true;
    throw error;
  }
  return answer;
}

async function askNvidia(prompt) {
  const apiKey = requireEnv('NVIDIA_API_KEY');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestCompletion(apiKey, prompt);
    } catch (error) {
      if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;
      await delay(attempt * 2_000);
    }
  }
}

function splitForDiscord(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += 1_900) {
    chunks.push(text.slice(index, index + 1_900));
  }
  return chunks;
}

async function discordRequest(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function registerCommands() {
  const applicationId = requireEnv('DISCORD_APPLICATION_ID');
  const botToken = requireEnv('DISCORD_BOT_TOKEN');

  const command = {
    name: 'ai',
    description: 'Ask the NVIDIA AI assistant a question',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: 'prompt',
        description: 'Your question or instruction',
        type: 3,
        required: true,
      },
    ],
  };

  await discordRequest(`/applications/${applicationId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${botToken}` },
    body: JSON.stringify([command]),
  });
  console.log('Registered global /ai command for user installation.');
}

async function sendFollowup(applicationId, interactionToken, content) {
  return discordRequest(`/webhooks/${applicationId}/${interactionToken}`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  });
}

function createServer() {
  const applicationId = requireEnv('DISCORD_APPLICATION_ID');
  const publicKey = requireEnv('DISCORD_PUBLIC_KEY');
  const app = express();

  app.get('/health', (_request, response) => response.json({ ok: true }));

  app.post('/interactions', express.raw({ type: 'application/json' }), async (request, response) => {
    const signature = request.header('X-Signature-Ed25519');
    const timestamp = request.header('X-Signature-Timestamp');
    const rawBody = request.body?.toString() || '';

    if (!signature || !timestamp || !(await verifyKey(rawBody, signature, timestamp, publicKey))) {
      response.status(401).send('Invalid request signature.');
      return;
    }

    const interaction = JSON.parse(rawBody);
    if (interaction.type === 1) {
      response.json({ type: 1 });
      return;
    }

    if (interaction.type !== 2 || interaction.data?.name !== 'ai') {
      response.status(400).send('Unsupported interaction.');
      return;
    }

    const prompt = interaction.data.options?.find((option) => option.name === 'prompt')?.value;
    const userId = interaction.member?.user?.id || interaction.user?.id;
    response.json({ type: 5 });

    try {
      const memory = extractMemory(prompt);
      await saveMemory(userId, memory);
      const answer = await askNvidia(await promptWithMemory(userId, prompt));
      for (const chunk of splitForDiscord(answer)) {
        await sendFollowup(applicationId, interaction.token, chunk);
      }
    } catch (error) {
      console.error('AI request failed:', error.message);
      await sendFollowup(
        applicationId,
        interaction.token,
        'I could not reach the AI service. Check the app terminal for details.'
      ).catch((followupError) => console.error('Follow-up failed:', followupError.message));
    }
  });

  return app;
}

async function main() {
  await initializeMemory();
  await registerCommands();
  const app = createServer();
  app.listen(PORT, () => {
    console.log(`Interaction server listening on port ${PORT}.`);
    console.log('Configure Discord Interactions Endpoint URL as: https://YOUR_DOMAIN/interactions');
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { askNvidia, requestCompletion, splitForDiscord, registerCommands, createServer };
