'use strict';

require('dotenv').config();

const express = require('express');
const { verifyKey } = require('discord-interactions');

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS) || 120_000;
const MAX_ATTEMPTS = 3;
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((userId) => userId.replace(/[^0-9]/g, ''))
    .filter(Boolean)
);
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
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    const wrapped = new Error(
      error.name === 'TimeoutError' || error.name === 'AbortError'
        ? `Groq request timed out after ${MODEL_TIMEOUT_MS}ms.`
        : `Network error contacting Groq: ${error.message}`
    );
    wrapped.retryable = true;
    throw wrapped;
  }

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Groq returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }

  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    const error = new Error('Groq returned an empty response.');
    error.retryable = true;
    throw error;
  }
  return answer;
}

async function askGroq(prompt) {
  const apiKey = requireEnv('GROQ_API_KEY');
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
    description: 'Ask the Groq AI assistant a question',
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

function isAllowedUser(userId) {
  return Boolean(userId) && ALLOWED_USER_IDS.has(userId);
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
    const userId = interaction.user?.id || interaction.member?.user?.id;

    if (!isAllowedUser(userId)) {
      response.json({
        type: 4,
        data: {
          content: 'This app is not enabled for your account.',
          flags: 64,
        },
      });
      console.warn('Rejected /ai request from a non-whitelisted user.');
      return;
    }

    response.json({ type: 5 });

    try {
      const answer = await askGroq(prompt);
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
  await registerCommands();
  const app = createServer();
  app.listen(PORT, () => {
    console.log(`Interaction server listening on port ${PORT}.`);
    console.log(`Loaded ${ALLOWED_USER_IDS.size} allowlisted Discord user ID(s).`);
    console.log('Configure Discord Interactions Endpoint URL as: https://YOUR_DOMAIN/interactions');
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { askGroq, requestCompletion, splitForDiscord, registerCommands, createServer };
