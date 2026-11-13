/** Control requests do no model work. Fence a stalled connection so startup or a model change cannot wait forever. */
export async function acpControl<T>(agent: string, request: () => Promise<T>, close: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${agent} did not finish setting up its session within 60 seconds. Check the CLI and its connectors, then retry.`));
      close();
    }, 60_000);
    timer.unref();
  });
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
