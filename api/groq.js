// Word-count targets by test duration (seconds)
const WORD_TARGETS = {
  60:  { min: 55,  max: 75,  label: '60-75 word',   floor: 35 },
  180: { min: 160, max: 200, label: '170-200 word', floor: 90 },
  300: { min: 270, max: 340, label: '280-330 word', floor: 160 }
};

// Big pool of real successful people across every domain — sampled and injected
// into every prompt so the AI has fresh raw material to draw from each time.
const PEOPLE_POOL = [
  // Scientists & mathematicians
  'Albert Einstein', 'Marie Curie', 'Nikola Tesla', 'Isaac Newton', 'Charles Darwin', 'Stephen Hawking',
  'Richard Feynman', 'Niels Bohr', 'Srinivasa Ramanujan', 'C.V. Raman', 'Homi Bhabha', 'Vikram Sarabhai',
  'Satyendra Nath Bose', 'Jagadish Chandra Bose', 'Rosalind Franklin', 'Barbara McClintock',
  'Jane Goodall', 'Katherine Johnson', 'Alan Turing', 'Ada Lovelace', 'Grace Hopper',
  'Tim Berners-Lee', 'Louis Pasteur', 'Alexander Fleming', 'Werner Heisenberg', 'Max Planck',
  // Inventors, engineers & tech founders
  'Thomas Edison', 'the Wright Brothers', 'Alexander Graham Bell', 'Henry Ford', 'Bill Gates',
  'Steve Jobs', 'Steve Wozniak', 'Elon Musk', 'Jeff Bezos', 'Larry Page', 'Sergey Brin',
  'Mark Zuckerberg', 'Sundar Pichai', 'Satya Nadella', 'Sam Altman', 'Jensen Huang',
  // Athletes (global + Indian)
  'Michael Jordan', 'Kobe Bryant', 'LeBron James', 'Usain Bolt', 'Serena Williams', 'Roger Federer',
  'Rafael Nadal', 'Muhammad Ali', 'Tiger Woods', 'Lionel Messi', 'Cristiano Ronaldo', 'Diego Maradona',
  'Simone Biles', 'Michael Phelps',
  'Sachin Tendulkar', 'M.S. Dhoni', 'Virat Kohli', 'Rahul Dravid', 'Kapil Dev', 'Sunil Gavaskar',
  'Milkha Singh', 'P.T. Usha', 'Mary Kom', 'P.V. Sindhu', 'Saina Nehwal', 'Neeraj Chopra',
  'Abhinav Bindra', 'Vishwanathan Anand', 'Pullela Gopichand', 'Leander Paes', 'Sania Mirza',
  // Leaders, statesmen & freedom fighters
  'Mahatma Gandhi', 'Nelson Mandela', 'Abraham Lincoln', 'Martin Luther King Jr.', 'Winston Churchill',
  'John F. Kennedy', 'Franklin D. Roosevelt', 'Dr. A.P.J. Abdul Kalam', 'Atal Bihari Vajpayee',
  'Sardar Vallabhbhai Patel', 'Jawaharlal Nehru', 'Bhagat Singh', 'Subhas Chandra Bose',
  'Rani Lakshmibai', 'Chhatrapati Shivaji Maharaj', 'B.R. Ambedkar', 'Barack Obama', 'Angela Merkel',
  // Entrepreneurs & business builders
  'Warren Buffett', 'Charlie Munger', 'Ratan Tata', 'J.R.D. Tata', 'Dhirubhai Ambani', 'Narayana Murthy',
  'Azim Premji', 'Kiran Mazumdar-Shaw', 'Falguni Nayar', 'Nikhil Kamath', 'Nithin Kamath',
  'Vijay Shekhar Sharma', 'Sachin Bansal', 'Byju Raveendran', 'Deepinder Goyal',
  'Walt Disney', 'Colonel Harland Sanders', 'Sam Walton', 'Howard Schultz', 'Jack Ma',
  'Sara Blakely', 'Oprah Winfrey', 'Estée Lauder',
  // Artists, musicians, filmmakers
  'Leonardo da Vinci', 'Michelangelo', 'Vincent van Gogh', 'Pablo Picasso', 'Ludwig van Beethoven',
  'Wolfgang Amadeus Mozart', 'Lata Mangeshkar', 'Kishore Kumar', 'A.R. Rahman', 'Ravi Shankar',
  'Bhimsen Joshi', 'M.F. Husain', 'Satyajit Ray', 'Guru Dutt', 'Amitabh Bachchan', 'Steven Spielberg',
  // Writers & thinkers
  'William Shakespeare', 'Rabindranath Tagore', 'Mark Twain', 'Maya Angelou', 'J.K. Rowling',
  'Stephen King', 'Ernest Hemingway', 'Chetan Bhagat', 'Sudha Murty', 'R.K. Narayan',
  'Ruskin Bond', 'Amish Tripathi', 'Arundhati Roy', 'Ruskin Bond',
  // Activists, teachers, humanitarians
  'Mother Teresa', 'Malala Yousafzai', 'Rosa Parks', 'Kailash Satyarthi', 'Greta Thunberg',
  'Aung San Suu Kyi', 'Medha Patkar', 'Anna Hazare', 'Sindhutai Sapkal', 'Baba Amte',
  'Helen Keller', 'Anne Sullivan',
  // Overcame extraordinary adversity
  'Nick Vujicic', 'Sudha Chandran', 'Arunima Sinha', 'Ravindra Jain', 'H. Ramakrishnan',
  // Explorers & astronauts
  'Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'Kalpana Chawla', 'Rakesh Sharma', 'Sunita Williams'
];

// 80 distinct themes across 8 categories.
const STORY_THEMES = [
  // Motivation
  { key: 'motivation',     category: 'Motivation', label: 'Motivation',      angle: 'the source of daily inner motivation, showing how it is a chosen action every morning rather than a feeling that arrives.' },
  { key: 'inspiration',    category: 'Motivation', label: 'Inspiration',     angle: 'how one inspired life inspires a thousand others.' },
  { key: 'drive',          category: 'Motivation', label: 'Drive',           angle: 'the fierce inner drive that pushes achievers past comfort into chosen suffering for a chosen future.' },
  { key: 'passion',        category: 'Motivation', label: 'Passion',         angle: 'passion as the fuel that outlasts talent.' },
  { key: 'ambition',       category: 'Motivation', label: 'Ambition',        angle: 'healthy ambition that lifts a whole community, not just the self.' },
  { key: 'determination',  category: 'Motivation', label: 'Determination',   angle: 'determination that refuses to quit even after uncounted failures.' },
  { key: 'enthusiasm',     category: 'Motivation', label: 'Enthusiasm',      angle: 'enthusiasm as a force multiplier that turns ordinary work into magic.' },
  { key: 'purpose',        category: 'Motivation', label: 'Purpose',         angle: 'living with purpose even in suffering, and how meaning gives strength.' },
  { key: 'initiative',     category: 'Motivation', label: 'Initiative',      angle: 'taking the first step without being asked or invited.' },
  { key: 'aspiration',     category: 'Motivation', label: 'Aspiration',      angle: 'aiming higher than your circumstances allow.' },
  // Commitment
  { key: 'commitment',     category: 'Commitment', label: 'Commitment',      angle: 'keeping a promise to yourself day after day when no one is watching.' },
  { key: 'dedication',     category: 'Commitment', label: 'Dedication',      angle: 'dedication to a craft over decades of quiet practice.' },
  { key: 'discipline',     category: 'Commitment', label: 'Discipline',      angle: 'discipline as the sum of small daily acts.' },
  { key: 'consistency',    category: 'Commitment', label: 'Consistency',     angle: 'the compound effect of consistency over intensity.' },
  { key: 'persistence',    category: 'Commitment', label: 'Persistence',     angle: 'persistence past rejection after rejection.' },
  { key: 'responsibility', category: 'Commitment', label: 'Responsibility',  angle: 'taking responsibility for outcomes instead of assigning blame.' },
  { key: 'accountability', category: 'Commitment', label: 'Accountability',  angle: 'radical accountability that owns the moment even when it costs.' },
  { key: 'reliability',    category: 'Commitment', label: 'Reliability',     angle: 'being the person others can count on when it matters most.' },
  { key: 'loyalty',        category: 'Commitment', label: 'Loyalty',         angle: 'loyalty to team and mission through hard seasons.' },
  { key: 'focus',          category: 'Commitment', label: 'Focus',           angle: 'the rare power of deep single-tasking focus in a distracted world.' },
  // Mindset
  { key: 'growth_mindset', category: 'Mindset',    label: 'Growth Mindset',  angle: 'the growth mindset — the belief that abilities are built, not born.' },
  { key: 'positive_mind',  category: 'Mindset',    label: 'Positive Mindset',angle: 'a positive mindset kept alive in the face of hardship.' },
  { key: 'success_mind',   category: 'Mindset',    label: 'Success Mindset', angle: 'thinking like a winner long before winning arrives.' },
  { key: 'learning_mind',  category: 'Mindset',    label: 'Learning Mindset',angle: 'the lifelong-learner mindset that keeps a curious beginner alive inside the expert.' },
  { key: 'resilient_mind', category: 'Mindset',    label: 'Resilient Mindset',angle: 'the resilient mindset that turns setbacks into fuel.' },
  { key: 'abundance_mind', category: 'Mindset',    label: 'Abundance Mindset',angle: 'the abundance mindset that knows there is enough for everyone and gives freely.' },
  { key: 'strategic',      category: 'Mindset',    label: 'Strategic Thinking',angle: 'strategic thinking that sees three moves ahead.' },
  { key: 'openminded',     category: 'Mindset',    label: 'Open-Mindedness', angle: 'open-mindedness that welcomes being proven wrong as a gift.' },
  { key: 'adaptability',   category: 'Mindset',    label: 'Adaptability',    angle: 'adaptability when the world shifts under your feet.' },
  { key: 'self_belief',    category: 'Mindset',    label: 'Self-Belief',     angle: 'self-belief that arrives long before the proof does.' },
  // Self-Development
  { key: 'self_aware',     category: 'Self-Development', label: 'Self-Awareness',      angle: 'self-awareness as the true beginning of every change.' },
  { key: 'self_conf',      category: 'Self-Development', label: 'Self-Confidence',     angle: 'building self-confidence brick by brick through small won battles.' },
  { key: 'self_disc',      category: 'Self-Development', label: 'Self-Discipline',     angle: 'self-discipline as doing what needs doing whether you feel like it or not.' },
  { key: 'emo_intel',      category: 'Self-Development', label: 'Emotional Intelligence',angle: 'emotional intelligence as the quiet skill of great leaders.' },
  { key: 'time_mgmt',      category: 'Self-Development', label: 'Time Management',     angle: 'protecting your calendar like it protects your future.' },
  { key: 'productivity',   category: 'Self-Development', label: 'Productivity',        angle: 'productivity as doing the right things, not everything.' },
  { key: 'cont_learn',     category: 'Self-Development', label: 'Continuous Learning', angle: 'the beginner\'s mind and the practice of continuous small improvement.' },
  { key: 'self_impr',      category: 'Self-Development', label: 'Self-Improvement',    angle: 'the compound of daily one-percent improvement over years.' },
  { key: 'reflection',     category: 'Self-Development', label: 'Reflection',          angle: 'reflection as a leader\'s secret tool — journaling, pausing, reviewing.' },
  { key: 'goal_setting',   category: 'Self-Development', label: 'Goal Setting',        angle: 'setting clear specific goals that pull you forward like a rope from the future.' },
  // Success Habits
  { key: 'hard_work',      category: 'Success Habits', label: 'Hard Work',      angle: 'the honesty of hard work when there are no shortcuts.' },
  { key: 'smart_work',     category: 'Success Habits', label: 'Smart Work',     angle: 'smart work with leverage that multiplies every hour spent.' },
  { key: 'perseverance',   category: 'Success Habits', label: 'Perseverance',   angle: 'perseverance through the invisible middle years when no one is applauding.' },
  { key: 'patience',       category: 'Success Habits', label: 'Patience',       angle: 'patience as an investing and life skill that compounds silently.' },
  { key: 'consistency_2',  category: 'Success Habits', label: 'Daily Consistency', angle: 'the compounding magic of a single small habit done every single day for a year.' },
  { key: 'resilience',     category: 'Success Habits', label: 'Resilience',     angle: 'resilience that turns hardship into strength.' },
  { key: 'grit',           category: 'Success Habits', label: 'Grit',           angle: 'grit as passion and perseverance held onto for long-term goals.' },
  { key: 'confidence',     category: 'Success Habits', label: 'Confidence',     angle: 'confidence built on real competence, not on posture.' },
  { key: 'courage',        category: 'Success Habits', label: 'Courage',        angle: 'courage as fear walked through anyway.' },
  { key: 'integrity',      category: 'Success Habits', label: 'Integrity',      angle: 'integrity as doing right when no one is watching.' },
  // Leadership
  { key: 'vision',         category: 'Leadership', label: 'Vision',           angle: 'a leader\'s vision that pulls the future closer to the present.' },
  { key: 'influence',      category: 'Leadership', label: 'Influence',        angle: 'leading without a title, through character alone.' },
  { key: 'empathy',        category: 'Leadership', label: 'Empathy',          angle: 'empathy as the underrated leadership superpower.' },
  { key: 'decision',       category: 'Leadership', label: 'Decision-Making',  angle: 'making a hard decision with incomplete information.' },
  { key: 'communication',  category: 'Leadership', label: 'Communication',    angle: 'communication that moves people to act.' },
  { key: 'teamwork',       category: 'Leadership', label: 'Teamwork',         angle: 'teamwork that beats individual talent.' },
  { key: 'account_lead',   category: 'Leadership', label: 'Owning Outcomes',  angle: 'a leader who takes the blame and gives the credit.' },
  { key: 'problem_solve',  category: 'Leadership', label: 'Problem-Solving',  angle: 'creative problem solving under pressure.' },
  { key: 'innovation',     category: 'Leadership', label: 'Innovation',       angle: 'innovation as the courage to think differently.' },
  { key: 'empowerment',    category: 'Leadership', label: 'Empowerment',      angle: 'lifting others up so they can rise past you.' },
  // Character
  { key: 'honesty',        category: 'Character', label: 'Honesty',           angle: 'honesty as the foundation of trust.' },
  { key: 'respect',        category: 'Character', label: 'Respect',           angle: 'respect for every human being, regardless of station.' },
  { key: 'kindness',       category: 'Character', label: 'Kindness',          angle: 'kindness as a quiet revolution.' },
  { key: 'gratitude',      category: 'Character', label: 'Gratitude',         angle: 'gratitude as a daily practice that rewires the mind toward hope.' },
  { key: 'humility',       category: 'Character', label: 'Humility',          angle: 'humility in great leaders who never forget their origins.' },
  { key: 'optimism',       category: 'Character', label: 'Optimism',          angle: 'optimism that is clear-eyed, not naive.' },
  { key: 'compassion',     category: 'Character', label: 'Compassion',        angle: 'compassion in action, not just in words.' },
  { key: 'fairness',       category: 'Character', label: 'Fairness',          angle: 'fairness at work and at home.' },
  { key: 'generosity',     category: 'Character', label: 'Generosity',        angle: 'generosity that expects nothing back.' },
  { key: 'trust',          category: 'Character', label: 'Trustworthiness',   angle: 'trustworthiness built over years and lost in a moment.' },
  // Performance
  { key: 'excellence',     category: 'Performance', label: 'Excellence',      angle: 'excellence as a habit, not an act.' },
  { key: 'execution',      category: 'Performance', label: 'Execution',       angle: 'execution beating brilliant ideas that never shipped.' },
  { key: 'results',        category: 'Performance', label: 'Results',         angle: 'results as the final scoreboard that separates dreams from delivery.' },
  { key: 'efficiency',     category: 'Performance', label: 'Efficiency',      angle: 'efficiency as doing more with less.' },
  { key: 'effectiveness',  category: 'Performance', label: 'Effectiveness',   angle: 'effectiveness as doing the right things, before doing things right.' },
  { key: 'achievement',    category: 'Performance', label: 'Achievement',     angle: 'the quiet satisfaction of hard-won achievement.' },
  { key: 'mastery',        category: 'Performance', label: 'Mastery',         angle: 'mastery earned through thousands of hours of deliberate practice.' },
  { key: 'progress',       category: 'Performance', label: 'Progress',        angle: 'progress over perfection, one honest step at a time.' },
  { key: 'success',        category: 'Performance', label: 'Success',         angle: 'defining your own success rather than borrowing someone else\'s.' },
  { key: 'excellence_2',   category: 'Performance', label: 'Pursuit of Excellence', angle: 'the endless pursuit of excellence long after applause fades.' }
];

const TONES = [
  'energizing and bold tone that awakens potential',
  'calm and reflective tone that inspires quiet resolve',
  'dramatic storytelling tone with vivid sensory imagery',
  'warm and encouraging tone like a trusted mentor',
  'crisp and confident tone that sharpens focus',
  'hopeful and uplifting tone that celebrates progress',
  'grounded and honest tone that respects the reader\'s struggle',
  'cinematic tone that puts the reader inside the moment'
];

// Fisher-Yates shuffle for random-sample without duplicates.
function sampleWithoutReplacement(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_API || process.env.GROQ_KEY;
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const wpm = Number(body.wpm || 0);
  const accuracy = Number(body.acc || body.accuracy || 100);
  const duration = Number(body.duration || 300);
  const excludeThemes = Array.isArray(body.excludeThemes) ? body.excludeThemes : [];
  const excludePeople = Array.isArray(body.excludePeople) ? body.excludePeople : [];
  const requestedCategory = typeof body.category === 'string' ? body.category : null;

  if (!apiKey) {
    return res.status(503).json({ error: 'AI service not configured', message: 'GROQ_API_KEY is missing on the server.', source: 'config-missing' });
  }

  const target = WORD_TARGETS[duration] || WORD_TARGETS[300];

  // Pick a theme, filtering by category and skipping recent ones.
  let pool = STORY_THEMES;
  if (requestedCategory) {
    const filtered = pool.filter(t => t.category.toLowerCase() === requestedCategory.toLowerCase());
    if (filtered.length > 0) pool = filtered;
  }
  const availableThemes = pool.filter(t => !excludeThemes.includes(t.key));
  const themePool = availableThemes.length > 0 ? availableThemes : pool;
  const theme = themePool[Math.floor(Math.random() * themePool.length)];

  // Sample 5 candidate people the AI can choose from, avoiding recent ones.
  const availablePeople = PEOPLE_POOL.filter(p => !excludePeople.includes(p));
  const peopleSource = availablePeople.length >= 5 ? availablePeople : PEOPLE_POOL;
  const candidatePeople = sampleWithoutReplacement(peopleSource, 5);

  const tone = TONES[Math.floor(Math.random() * TONES.length)];
  const level = wpm >= 55 && accuracy >= 95 ? 'advanced'
              : wpm >= 30 && accuracy >= 88 ? 'intermediate'
              : 'beginner';
  const vocabHint = level === 'advanced'
    ? 'Use rich, precise vocabulary that stretches an advanced typist.'
    : level === 'intermediate'
    ? 'Use everyday English with occasional richer words for texture.'
    : 'Use simple everyday English — short common words, short clear sentences.';

  const systemPrompt = 'You are an inspiring writer who crafts short motivational passages for a typing test. You always respond with valid JSON only — no markdown fences, no preamble, no commentary. You use only common English words and standard ASCII punctuation (periods, commas, apostrophes, quotation marks, hyphens). You never use em dashes, semicolons, ellipses, curly quotes, or unusual characters. You never open with clichés like "In a world where," "Once upon a time," or "Imagine."';

  const userPrompt = `Write a motivational typing-test passage on the theme "${theme.label}" (category: ${theme.category}).

Focus of the passage: ${theme.angle}

Ground the passage in the TRUE life of exactly ONE of these real people (pick whichever fits the theme best):
${candidatePeople.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Include specific true details from that person's life — a real place, a real year, a real event, a real quote if possible. Do not blend biographies. Do not invent facts.

Craft the passage as a mini narrative arc:
1. Open with a concrete moment or image (a place, a year, a sound, a scene).
2. Show the struggle or obstacle in specific detail.
3. Show the turning point or persistent effort.
4. Close with a lesson that speaks directly to the reader typing this passage right now.

Hard requirements:
- The passage MUST contain between ${target.min} and ${target.max} words (a ${target.label} passage). Count words carefully.
- ${vocabHint}
- Adopt a ${tone}.
- Use ONLY standard ASCII punctuation. No em dashes, no semicolons, no ellipses, no curly quotes.
- Do NOT start with "In a world," "Once upon a time," "Imagine," or "Picture this."

Return exactly this JSON structure and NOTHING else. Also include the person you chose in the "person" field:
{"passage": "<the ${target.label} passage>", "tip": "<one short encouraging coaching sentence, under 20 words>", "person": "<name of the person you wrote about>"}

User context: ${wpm} WPM, ${accuracy}% accuracy, difficulty ${level}, test duration ${duration} seconds. Random seed: ${Math.random().toString(36).slice(2, 8)}.`;

  // Active Groq models as of 2026 — llama3-70b-8192 is decommissioned, removed.
  const models = [
    process.env.GROQ_MODEL,
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'moonshotai/kimi-k2-instruct',
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
          temperature: 0.95,
          max_tokens: duration >= 300 ? 1400 : duration >= 180 ? 900 : 450,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      if (!r.ok) {
        const errText = (await r.text()).slice(0, 160);
        attempts.push({ model, error: `HTTP ${r.status}: ${errText}` });
        continue;
      }

      const data = await r.json();
      const content = data?.choices?.[0]?.message?.content || '';

      let jsonStr = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];

      let parsed;
      try { parsed = JSON.parse(jsonStr); }
      catch (parseErr) { attempts.push({ model, error: `JSON parse failed: ${parseErr.message}` }); continue; }

      let passage = String(parsed.passage || parsed.text || parsed.content || parsed.paragraph || parsed.body || '')
        .replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
        .replace(/\s+/g, ' ').trim();

      const wordCount = passage.split(/\s+/).filter(Boolean).length;
      // More lenient floor so a slightly short passage still passes rather than failing entirely.
      if (!passage || wordCount < target.floor) {
        attempts.push({ model, error: `passage too short (${wordCount} words)` });
        continue;
      }

      const tip = String(parsed.tip || parsed.coaching || 'Keep your rhythm steady and breathe.')
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

      const person = String(parsed.person || parsed.subject || '').trim() || null;

      return res.status(200).json({
        passage, tip, source: 'groq', model,
        theme: theme.key, themeLabel: theme.label, category: theme.category,
        person, level, wordCount, duration
      });
    } catch (e) {
      attempts.push({ model, error: e.message || 'unknown error' });
      continue;
    }
  }

  // All models failed. Return a friendly error the client can show as a refresh prompt.
  return res.status(502).json({
    error: 'AI temporarily unavailable',
    message: 'The AI service is busy right now. Please refresh the page (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows) and try again.',
    attempts,  // kept for console debugging, not shown to user
    source: 'ai-failed'
  });
};
