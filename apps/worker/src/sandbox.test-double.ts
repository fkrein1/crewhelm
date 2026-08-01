import { DurableObject } from "cloudflare:workers";

export class TestCodeSandbox extends DurableObject {
  async destroyAndPurge(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
