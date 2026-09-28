/** Stable IDs only: cached projects never contain copies of the bundled geometry. */
export const PROJECT_STACK_LABELS = {
  react: "React",
  nextjs: "Next.js",
  nestjs: "NestJS",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  astro: "Astro",
  angular: "Angular",
  express: "Express",
  laravel: "Laravel",
  django: "Django",
  fastapi: "FastAPI",
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  csharp: "C#",
  ruby: "Ruby",
  php: "PHP",
  swift: "Swift",
  c: "C",
  cpp: "C++",
} as const;

export type ProjectStackIconId = keyof typeof PROJECT_STACK_LABELS;

export function isProjectStackIconId(value: unknown): value is ProjectStackIconId {
  return typeof value === "string" && Object.hasOwn(PROJECT_STACK_LABELS, value);
}
