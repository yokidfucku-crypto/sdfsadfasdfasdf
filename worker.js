const DISCORD_API = 'https://discord.com/api/v10';
const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
function hexToBytes(hex) {
  if (!/^[0-9a-f]{2,}$/i.test(hex) || hex.length % 2 !== 0) throw new Error('Invalid hex value.');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function concatBytes(...arrays) {
  const result = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

async function verifyDiscordRequest(request, body, publicKeyHex) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  // Ed25519 SubjectPublicKeyInfo prefix followed by Discord's 32-byte public key.
  const spkiPrefix = hexToBytes('302a300506032b6570032100');
  const publicKey = await crypto.subtle.importKey(
    'spki',
    concatBytes(spkiPrefix, hexToBytes(publicKeyHex)),
    { name: 'Ed25519' },
    false,
    ['verify']
  );

  return crypto.subtle.verify(
    'Ed25519',
    publicKey,
    hexToBytes(signature),
    concatBytes(new TextEncoder().encode(timestamp), new Uint8Array(body))
  );
}

async function askNvidia(prompt, apiKey, model = DEFAULT_MODEL) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 2048,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });

      if (!response.ok) {
        const details = await response.text();
        const error = new Error(`NVIDIA HTTP ${response.status}: ${details.slice(0, 300)}`);
        if (response.status < 500 && response.status !== 429) throw error;
        throw error;
      }

      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error('NVIDIA returned an empty response.');
      return answer;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

function chunks(text) {
  const result = [];
  for (let i = 0; i < text.length; i += 1900) result.push(text.slice(i, i + 1900));
  return result;
}

async function followUp(interaction, content) {
  return fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

async function processInteraction(interaction, env) {
  const prompt = interaction.data.options?.find((option) => option.name === 'prompt')?.value;
  try {
    const answer = await askNvidia(prompt, env.NVIDIA_API_KEY, env.NVIDIA_MODEL);
    for (const chunk of chunks(answer)) await followUp(interaction, chunk);
  } catch (error) {
    console.error(error.message);
    await followUp(interaction, 'I could not reach the AI service right now.').catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('AI app is online.');
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/interactions') {
      return new Response('Not found.', { status: 404 });
    }

    const body = await request.arrayBuffer();
    if (!(await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response('Invalid request signature.', { status: 401 });
    }

    const interaction = JSON.parse(new TextDecoder().decode(body));
    if (interaction.type === 1) return Response.json({ type: 1 });
    if (interaction.type !== 2 || interaction.data?.name !== 'ai') {
      return new Response('Unsupported interaction.', { status: 400 });
    }

    const userId = interaction.user?.id || interaction.member?.user?.id;
    const allowedUserIds = new Set(
      (env.ALLOWED_USER_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
    if (!userId || !allowedUserIds.has(userId)) {
      return Response.json({
        type: 4,
        data: { content: 'This app is not enabled for your account.', flags: 64 },
      });
    }

    ctx.waitUntil(processInteraction(interaction, env));
    return Response.json({ type: 5 });
  },
};
