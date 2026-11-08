// Types matching the structure produced by CF-scraper-python

export type Block =
  | { type: 'paragraph'; html: string; text: string }  // html = raw MathJax, text = clean $latex$
  | { type: 'code'; language?: string; code: string }
  | { type: 'image'; src: string; alt?: string }        // src = "cf-image://filename.png"
  | { type: 'table'; html: string }
  | { type: 'list'; ordered: boolean; items: string[] };

export interface Example {
  input: string;
  output: string;
  explanation?: string;
  transcript?: string;
}

export interface ProblemStatement {
  title: string;
  timeLimit: string;
  memoryLimit: string;
  inputMode?: string;
  outputMode?: string;
  isInteractive?: boolean;
  description: Block[];
  input: Block[];
  output: Block[];
  constraints?: Block[];
  interaction?: Block[];
  examples: Example[];
  note?: Block[];
}

export interface CachedProblem {
  contestId: number;
  index: string;
  cachedAt: number;   // unix timestamp seconds
  version: number;
  statement: ProblemStatement;
}

export interface CsesProblemSummary {
  id: string;
  taskId: number;
  name: string;
  category: string;
  solvedCount?: number | null;
  attemptCount?: number | null;
  url?: string;
  isCses: true;
}

export interface CachedCsesProblem {
  id: string;
  taskId: number;
  name: string;
  category: string;
  solvedCount?: number | null;
  attemptCount?: number | null;
  url: string;
  cachedAt: number;
  version: number;
  statement: ProblemStatement;
}
