export class DataLoader<K, V> {
  private keys: K[] = [];
  private promises: Array<{ resolve: (value: V | Error) => void }> = [];
  private currentTick: Promise<void> | null = null;

  constructor(private readonly batchLoadFn: (keys: K[]) => Promise<(V | Error)[]>) {}

  load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      this.keys.push(key);
      this.promises.push({
        resolve: (value) => {
          if (value instanceof Error) reject(value);
          else resolve(value);
        },
      });

      if (!this.currentTick) {
        this.currentTick = Promise.resolve().then(() => {
          const keysToLoad = this.keys;
          const currentPromises = this.promises;
          this.keys = [];
          this.promises = [];
          this.currentTick = null;

          this.batchLoadFn(keysToLoad)
            .then((results) => {
              for (let i = 0; i < currentPromises.length; i++) {
                currentPromises[i]!.resolve(results[i] as V | Error);
              }
            })
            .catch((err) => {
              for (const p of currentPromises) {
                p.resolve(err);
              }
            });
        });
      }
    });
  }
}
