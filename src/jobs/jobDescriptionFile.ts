/**
 * Job descriptions are stored as Markdown files (data/job_descriptions/*.md).
 * This module reads them. The format is documented below.
 *
 * Layout:
 *   ---
 *   id: job_003_data_scientist
 *   title: Data Scientist
 *   department: Data & Analytics
 *   experience_level: mid
 *   years_experience_min: 3
 *   years_experience_max: 8
 *   created_at: 2026-10-01T10:00:00Z
 *   updated_at: 2026-10-09T10:00:00Z
 *   ---
 *   # Data Scientist
 *   ## Description
 *   <one or more paragraphs>
 *   ## Responsibilities
 *   - **Title**: description
 *   ## Skills
 *   | Skill | Category | Level | Importance |
 *   |---|---|---|---|
 *   | Python | technical | advanced | 5 |
 *   ## Nice to have
 *   - Skill
 *
 * The parser checks every required field, so a malformed file fails with its name, not a silent gap.
 */

export interface JobSkill {
  name: string;
  category: string;
  level: string;
  /** 1 (nice) to 5 (essential). Skills at 4 or above must be covered by Mode C questions. */
  importance: number;
}

export interface JobResponsibility {
  title: string;
  description: string;
}

export interface JobDescriptionRecord {
  id: string;
  title: string;
  description: string;
  department: string;
  experience_level: string;
  years_experience: { min: number; max: number };
  skills: JobSkill[];
  responsibilities: JobResponsibility[];
  nice_to_have_skills: string[];
  created_at: string;
  updated_at: string;
}

const EXPERIENCE_LEVELS = ['entry', 'junior', 'mid', 'senior', 'lead'];
const META_KEYS = [
  'id',
  'title',
  'department',
  'experience_level',
  'years_experience_min',
  'years_experience_max',
  'created_at',
  'updated_at',
];

/** Split the body into "## Heading" sections, keyed by lower-cased heading */
function sectionsOf(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) sections[current] = buffer.join('\n').trim();
  };
  for (const line of body.split('\n')) {
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      flush();
      current = heading[1].trim().toLowerCase();
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Rows of a Markdown table, after the header and separator, with escaped pipes restored */
function tableRows(text: string): string[][] {
  const rows = text
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim()));
  // rows[0] is the header and rows[1] the separator
  return rows.slice(2);
}

export function parseJobDescription(markdown: string, fileName: string): JobDescriptionRecord {
  const text = markdown.replace(/\r\n?/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${fileName}: the file must start with front matter between --- lines`);
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`${fileName}: invalid front matter line "${line}"`);
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  for (const key of META_KEYS) {
    if (!meta[key]) throw new Error(`${fileName}: missing "${key}" in front matter`);
  }
  if (!EXPERIENCE_LEVELS.includes(meta.experience_level)) {
    throw new Error(`${fileName}: experience_level must be one of ${EXPERIENCE_LEVELS.join(', ')}`);
  }

  const sections = sectionsOf(match[2]);
  const description = sections['description'];
  if (!description) throw new Error(`${fileName}: missing "## Description" section`);

  const responsibilities: JobResponsibility[] = (sections['responsibilities'] || '')
    .split('\n')
    .map((line) => line.match(/^- \*\*(.+?)\*\*: (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ title: m[1].trim(), description: m[2].trim() }));
  if (responsibilities.length === 0) {
    throw new Error(`${fileName}: "## Responsibilities" needs at least one "- **Title**: description" item`);
  }

  const skills: JobSkill[] = tableRows(sections['skills'] || '').map((row) => {
    const [name, category, level, importance] = row;
    const value = Number(importance);
    if (!name || !Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`${fileName}: skill row "${row.join(' | ')}" needs an importance from 1 to 5`);
    }
    return { name, category: category || 'technical', level: level || 'intermediate', importance: value };
  });
  if (skills.length === 0) throw new Error(`${fileName}: "## Skills" needs at least one table row`);

  const nice = (sections['nice to have'] || '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());

  const min = Number(meta.years_experience_min);
  const max = Number(meta.years_experience_max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(`${fileName}: years_experience_min and years_experience_max must be numbers`);
  }

  return {
    id: meta.id,
    title: meta.title,
    description,
    department: meta.department,
    experience_level: meta.experience_level,
    years_experience: { min, max },
    skills,
    responsibilities,
    nice_to_have_skills: nice,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
}
