export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'skipped';

export interface TaskItem {
  id: string;
  title: string;
  objective: string;
  acceptance: string;
  status: TaskStatus;
  suggestedTools: string[];
  relevantSkills: string[];
  attempts: number;
  summary?: string;
  artifacts?: string[];
}

export interface TaskPlan {
  id: string;
  goal: string;
  summary: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  currentTaskId?: string;
  tasks: TaskItem[];
}

export interface TaskUpdate {
  status: Extract<TaskStatus, 'completed' | 'blocked' | 'failed'>;
  summary: string;
  artifacts?: string[];
  userFacing?: string;
  needsReplan?: boolean;
}

export function generatePlanId(): string {
  return `plan_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

export function normalizeTaskPlan(
  raw: unknown,
  goal: string,
  availableTools: string[],
  availableSkills: string[],
): TaskPlan {
  const now = Date.now();
  const input = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];

  const tasks = rawTasks
    .map((task, index) => normalizeTask(task, index, availableTools, availableSkills))
    .filter(Boolean) as TaskItem[];

  if (tasks.length === 0) {
    return createFallbackTaskPlan(goal, availableTools, availableSkills);
  }

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : generatePlanId(),
    goal,
    summary: asNonEmptyString(input.summary) || `Complete the user's request: ${goal}`,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    tasks,
  };
}

export function createFallbackTaskPlan(
  goal: string,
  availableTools: string[],
  availableSkills: string[],
): TaskPlan {
  const now = Date.now();
  const tasks: TaskItem[] = [];
  const lowered = goal.toLowerCase();
  const sendRequested = /\b(send|share|attach|upload|deliver)\b/.test(lowered);
  const fileRequested = /\b(docx|pdf|file|document|word)\b/.test(lowered);

  tasks.push({
    id: 'task_1',
    title: fileRequested ? 'Inspect the requested work item' : 'Analyze the request and gather research',
    objective: fileRequested
      ? 'Inspect the target file or working materials and gather the exact change needed.'
      : 'Research the user goal, gather necessary data, and determine the concrete output needed.',
    acceptance: 'The agent has collected enough information to provide a high-quality answer.',
    status: 'pending',
    suggestedTools: pickRelevantTools(availableTools, ['read_file', 'list_dir', 'web_search']),
    relevantSkills: pickRelevantSkills(availableSkills, lowered),
    attempts: 0,
  });

  tasks.push({
    id: 'task_2',
    title: fileRequested ? 'Do the requested work' : 'Compile and deliver findings',
    objective: fileRequested
      ? 'Make the requested edits or produce the requested file/output.'
      : 'Synthesize the gathered information into a final response for the user.',
    acceptance: 'The user has received a complete and accurate response.',
    status: 'pending',
    suggestedTools: pickRelevantTools(availableTools, ['write_file', 'exec', 'read_file']),
    relevantSkills: pickRelevantSkills(availableSkills, lowered),
    attempts: 0,
  });

  if (sendRequested) {
    tasks.push({
      id: 'task_3',
      title: 'Deliver the result',
      objective: 'Send the completed result back through the current channel.',
      acceptance: 'The result has been delivered successfully to the user.',
      status: 'pending',
      suggestedTools: pickRelevantTools(availableTools, ['send_file', 'write_file']),
      relevantSkills: [],
      attempts: 0,
    });
  }

  return {
    id: generatePlanId(),
    goal,
    summary: `Plan the work and complete it step by step for: ${goal}`,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    tasks,
  };
}

export function formatTaskPlanForPrompt(plan: TaskPlan): string {
  const lines = [
    `Goal: ${plan.goal}`,
    `Plan summary: ${plan.summary}`,
    'Tasks:',
  ];

  for (const [index, task] of plan.tasks.entries()) {
    lines.push(
      `${index + 1}. ${task.title} [${task.status}]`,
      `Objective: ${task.objective}`,
      `Acceptance: ${task.acceptance}`,
      `Suggested tools: ${task.suggestedTools.join(', ') || 'none'}`,
      `Relevant skills: ${task.relevantSkills.join(', ') || 'none'}`,
      `Attempts: ${task.attempts}`,
      task.summary ? `Summary: ${task.summary}` : 'Summary: pending',
    );
  }

  return lines.join('\n');
}

export function getNextPendingTask(plan: TaskPlan): TaskItem | null {
  return plan.tasks.find(task => task.status === 'pending') ?? null;
}

export function extractTaggedJson<T>(sources: string[], tagName: string): T | null {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');

  for (const source of sources) {
    if (!source) continue;

    const tagged = source.match(regex);
    if (tagged?.[1]) {
      const parsed = parseJsonWithCleanup<T>(tagged[1]);
      if (parsed) return parsed;
    }

    const fenced = source.match(/```(?:json)?\s*({[\s\S]*?})\s*```/i);
    if (fenced?.[1]) {
      const parsed = parseJsonWithCleanup<T>(fenced[1]);
      if (parsed) return parsed;
    }
  }

  return null;
}

export function stripTaggedBlock(text: string, tagName: string): string {
  return text.replace(new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, 'gi'), '').trim();
}

function normalizeTask(
  raw: unknown,
  index: number,
  availableTools: string[],
  availableSkills: string[],
): TaskItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, any>;

  const title = asNonEmptyString(input.title);
  const objective = asNonEmptyString(input.objective) || asNonEmptyString(input.description);
  const acceptance = asNonEmptyString(input.acceptance) || asNonEmptyString(input.successCriteria);

  if (!title || !objective) return null;

  return {
    id: asNonEmptyString(input.id) || `task_${index + 1}`,
    title,
    objective,
    acceptance: acceptance || 'Task objective is satisfied.',
    status: 'pending',
    suggestedTools: normalizeStringList(input.suggestedTools, availableTools),
    relevantSkills: normalizeStringList(input.relevantSkills, availableSkills),
    attempts: 0,
  };
}

function normalizeStringList(input: unknown, allowed: string[]): string[] {
  if (!Array.isArray(input)) return [];
  const allowedSet = new Set(allowed.map(item => item.toLowerCase()));

  return input
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .filter(item => allowedSet.has(item.toLowerCase()));
}

function parseJsonWithCleanup<T>(raw: string): T | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Attempt cleanup: remove leading/trailing non-json chars
    const cleaned = trimmed
      .replace(/^[^{[]+/, '')
      .replace(/[^}\]]+$/, '');

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // Last ditch: if it's an object, try to extract key-values via regex (very basic)
      if (cleaned.startsWith('{')) {
        const result: Record<string, any> = {};
        const kvPattern = /["']?(\w+)["']?\s*[:=]\s*(?:["']([^"']*?)["']|(\d+)|(true|false|null))/g;
        let match;
        while ((match = kvPattern.exec(cleaned)) !== null) {
          const key = match[1];
          const val = match[2] ?? (match[3] ? Number(match[3]) : match[4] === 'true' ? true : match[4] === 'false' ? false : null);
          result[key] = val;
        }
        if (Object.keys(result).length > 0) return result as T;
      }
      return null;
    }
  }
}

function asNonEmptyString(input: unknown): string {
  return typeof input === 'string' && input.trim() ? input.trim() : '';
}

function pickRelevantTools(availableTools: string[], preferred: string[]): string[] {
  const available = new Set(availableTools);
  return preferred.filter(tool => available.has(tool));
}

function pickRelevantSkills(availableSkills: string[], loweredGoal: string): string[] {
  return availableSkills.filter(skill => loweredGoal.includes(skill.toLowerCase().replace(/[-_]/g, ' ')));
}
