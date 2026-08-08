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
}

export interface ProblemStatement {
  title: string;
  timeLimit: string;
  memoryLimit: string;
  description: Block[];
  input: Block[];
  output: Block[];
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
