/**
 * Netlify Function: chat
 *
 * Proxies to OpenAI with an agentic loop:
 *   1. System prompt = wiki index.md (entry point for navigation)
 *   2. Model has a read_page(path) tool to retrieve any wiki page on demand
 *   3. Loop until model produces a text response (cap: 5 tool calls per request)
 *
 * Env vars:
 *   OPENAI_API_KEY  (required)
 *   OPENAI_MODEL    (optional, default: gpt-4o-mini)
 */

import { index, pages } from './wiki-pages.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You are a philosophical discussion guide for Nietzsche's On the Genealogy of Morals, Second Essay: "Guilt, Bad Conscience, and the Like" (Kaufmann translation, §1–25).

You have access to a curated wiki built around this essay. Navigate it the way you would navigate any well-organized knowledge base:
- The wiki index below lists all pages with brief descriptions — read it to find what's relevant to any question
- Use the read_page tool to retrieve the full content of any page that will help you answer
- Synthesize answers with §-number citations (§1, §14, etc.)

Key terms to use consistently:
- Schuld = guilt / debt (the double meaning is central to §4)
- schlechtes Gewissen = bad conscience
- Ressentiment (keep the French, as Nietzsche does)
- Vergesslichkeit = active forgetting
- Wille zur Macht = will to power

Be a rigorous but welcoming interlocutor. Draw people into thinking, don't just inform. Acknowledge genuine tensions and ambiguities. This is for book club discussion prep.

WIKI INDEX:
${index}`;

const READ_PAGE_TOOL = {
  type: 'function',
  function: {
    name: 'read_page',
    description: 'Read the full content of a wiki page by its path. Use paths exactly as listed in the index (e.g. "concepts/bad-conscience.md", "connections/debt-creates-guilt.md").',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The wiki page path relative to content/, e.g. "concepts/sovereign-individual.md"',
        },
      },
      required: ['path'],
    },
  },
};

function readPage(path) {
  const content = pages[path];
  if (!content) {
    const available = Object.keys(pages).join('\n');
    return `Page not found: "${path}"\n\nAvailable pages:\n${available}`;
  }
  return content;
}

async function callOpenAI(messages, apiKey, model) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: [READ_PAGE_TOOL],
      tool_choice: 'auto',
      max_completion_tokens: 10000,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI ${response.status}: ${body}`);
  }

  return response.json();
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'OPENAI_API_KEY not configured' }),
    };
  }

  let userMessages;
  try {
    ({ messages: userMessages } = JSON.parse(event.body));
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...userMessages];

  // Agentic loop: keep calling until we get a text response or hit the cap
  const MAX_TOOL_CALLS = 5;
  let toolCallCount = 0;

  try {
    while (toolCallCount <= MAX_TOOL_CALLS) {
      const data = await callOpenAI(messages, apiKey, model);
      const choice = data.choices[0];

      if (choice.finish_reason === 'tool_calls') {
        // Append the assistant's tool-call message
        messages.push(choice.message);

        // Execute each tool call and append results
        for (const toolCall of choice.message.tool_calls) {
          let result;
          if (toolCall.function.name === 'read_page') {
            const { path } = JSON.parse(toolCall.function.arguments);
            result = readPage(path);
          } else {
            result = `Unknown tool: ${toolCall.function.name}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });

          toolCallCount++;
        }
      } else {
        // Final text response
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: choice.message.content }),
        };
      }
    }

    // Hit the cap — ask the model to respond with what it has
    messages.push({
      role: 'user',
      content: '[Please provide your best answer now based on what you have read.]',
    });
    const final = await callOpenAI(messages, apiKey, model);
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: final.choices[0].message.content }),
    };
  } catch (err) {
    console.error('Chat function error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message ?? 'Internal error' }),
    };
  }
};
