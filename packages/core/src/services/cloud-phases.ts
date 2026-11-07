/** How long each step of a cloud start or turn took, said in one line once it is done. */
export class Phases {
  private readonly began = Date.now();
  private readonly took: [string, number][] = [];

  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      return await work();
    } finally {
      this.took.push([name, Date.now() - at]);
    }
  }

  /** The steps so far, by name, in milliseconds. */
  get steps(): Record<string, number> {
    return Object.fromEntries(this.took);
  }

  line(what: string): string {
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    return `${what} in ${seconds(Date.now() - this.began)} (${this.took.map(([name, ms]) => `${name} ${seconds(ms)}`).join(", ")})`;
  }
}
