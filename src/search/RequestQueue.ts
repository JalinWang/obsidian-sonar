interface QueuedRequest<TRes> {
  componentId: string;
  resolve: (value: TRes | null) => void;
  reject: (error: unknown) => void;
}

type QueuedEntry<TReq extends { componentId: string }, TRes> = TReq &
  QueuedRequest<TRes>;

export class RequestQueue<TReq extends { componentId: string }, TRes> {
  private queue: QueuedEntry<TReq, TRes>[] = [];
  private isProcessing = false;

  constructor(private processor: (request: TReq) => Promise<TRes>) {}

  async enqueue(request: TReq): Promise<TRes | null> {
    const newQueue: QueuedEntry<TReq, TRes>[] = [];
    for (const req of this.queue) {
      if (req.componentId === request.componentId) {
        req.resolve(null);
      } else {
        newQueue.push(req);
      }
    }
    this.queue = newQueue;

    return new Promise((resolve, reject) => {
      this.queue.push({ ...request, resolve, reject });
      this.processQueue();
    });
  }

  cancelByComponent(componentId: string): void {
    const newQueue: QueuedEntry<TReq, TRes>[] = [];
    for (const req of this.queue) {
      if (req.componentId === componentId) {
        req.resolve(null);
      } else {
        newQueue.push(req);
      }
    }
    this.queue = newQueue;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const request = this.queue.shift()!;
    try {
      const result = await this.processor(request);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    }
    this.isProcessing = false;
    this.processQueue();
  }
}
