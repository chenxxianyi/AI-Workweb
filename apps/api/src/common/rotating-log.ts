import { Writable } from 'node:stream';
import { appendFile, mkdir, stat, rename, readdir, rm } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
/** 单进程串行写入与轮转；不用copy/truncate破坏仍打开的stdout文件偏移。 */
export class RotatingLog extends Writable {
  private bytes = 0;
  private sequence = 0;
  private initialized: Promise<void>;
  private readonly file: string;
  constructor(
    file: string,
    private readonly maxBytes = 20 * 1024 * 1024,
    private readonly archives = 10,
  ) {
    super();
    const target=resolve(file);
    this.file = target;
    this.initialized = (async () => {
      await mkdir(dirname(target), { recursive: true });
      this.bytes = (await stat(target).catch(() => ({ size: 0 }))).size;
    })();
  }
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void (async () => {
      await this.initialized;
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.bytes > 0 && this.bytes + body.length > this.maxBytes) {
        await rename(
          this.file,
          this.file + '.' + String(Date.now()) + '-' + String(this.sequence++).padStart(4, '0'),
        );
        this.bytes = 0;
        const dir = dirname(this.file),
          prefix = basename(this.file) + '.',
          files = (await readdir(dir))
            .filter((f) => f.startsWith(prefix) && /^\d+-\d+$/.test(f.slice(prefix.length)))
            .sort()
            .reverse();
        for (const old of files.slice(this.archives)) await rm(join(dir, old));
      }
      await appendFile(this.file, body);
      this.bytes += body.length;
    })().then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }
}
