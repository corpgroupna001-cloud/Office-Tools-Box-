// AI quiz generator — POST { topic, difficulty } -> { questions: [...] }
// Generates 10 fresh multiple-choice questions on any topic via Groq.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_API || process.env.GROQ_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI not configured',
      message: 'GROQ_API_KEY is missing on the server.'
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const topic = String(body.topic || 'general knowledge').slice(0, 200).trim() || 'general knowledge';
  const requested = String(body.difficulty || 'mixed').toLowerCase();
  const difficulty = ['easy', 'medium', 'hard', 'mixed'].includes(requested) ? requested : 'mixed';
  const count = 10;

  const systemPrompt = 'You are a quiz question generator. You always respond with valid JSON only, no markdown fences, no preamble, no commentary. You use only common English words and standard ASCII punctuation.';

  const userPrompt = `Generate ${count} multiple-choice questions about "${topic}" at ${difficulty} difficulty.

Strict requirements:
- Each question has EXACTLY 4 options.
- "correct" is the 0-based index of the right option (0, 1, 2, or 3).
- Each question includes "difficulty" — one of "easy", "medium", "hard".
${difficulty === 'mixed' ? '- Mix easy, medium and hard across the 10 questions.' : `- All questions should be ${difficulty} difficulty.`}
- Each question includes "ex" — a brief single-sentence explanation of the correct answer.
- Options must be plausible distractors, not obviously wrong.
- Do not use markdown, HTML, code fences, or unusual characters.
- Facts must be verifiable; do not make up dates, names, or numbers.

Return EXACTLY this JSON structure and nothing else:
{
  "questions": [
    {"q": "question text?", "options": ["opt1", "opt2", "opt3", "opt4"], "correct": 0, "difficulty": "easy", "ex": "brief explanation"}
  ]
}

Random seed for variety: ${Math.random().toString(36).slice(2, 10)}`;

  const models = [
    process.env.GROQ_MODEL,
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant'
  ].filter(Boolean);
  const uniqueModels = [...new Set(models)];

  const attempts = [];

  for (const model of uniqueModels) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.75,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      if (!r.ok) {
        const errText = (await r.text()).slice(0, 200);
        attempts.push({ model, error: `HTTP ${r.status}: ${errText}` });
        continue;
      }

      const data = await r.json();
      const content = data?.choices?.[0]?.message?.content || '';
      let jsonStr = content.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];

      let parsed;
      try { parsed = JSON.parse(jsonStr); }
      catch (parseErr) {
        attempts.push({ model, error: `JSON parse: ${parseErr.message}` });
        continue;
      }

      const raw = Array.isArray(parsed.questions) ? parsed.questions : (Array.isArray(parsed) ? parsed : []);
      const questions = raw.filter(q =>
        q && typeof q.q === 'string' && q.q.trim().length > 5 &&
        Array.isArray(q.options) && q.options.length === 4 &&
        q.options.every(o => typeof o === 'string' && o.trim().length > 0) &&
        typeof q.correct === 'number' && q.correct >= 0 && q.correct < 4
      ).map(q => ({
        q: q.q.trim().replace(/\s+/g, ' '),
        options: q.options.map(o => o.trim().replace(/\s+/g, ' ')),
        correct: q.correct,
        difficulty: ['easy', 'medium', 'hard'].includes(String(q.difficulty).toLowerCase()) ? String(q.difficulty).toLowerCase() : (difficulty === 'mixed' ? 'medium' : difficulty),
        ex: String(q.ex || 'See relevant reference material.').trim().replace(/\s+/g, ' ')
      }));

      if (questions.length < 5) {
        attempts.push({ model, error: `Only ${questions.length} valid questions returned` });
        continue;
      }

      return res.status(200).json({
        questions: questions.slice(0, 10),
        topic,
        difficulty,
        source: 'groq',
        model,
        count: Math.min(10, questions.length)
      });
    } catch (e) {
      attempts.push({ model, error: e.message || 'unknown error' });
      continue;
    }
  }

  return res.status(502).json({
    error: 'AI service failed',
    message: 'The AI could not generate a quiz. Please refresh and try again.',
    attempts
  });
};
