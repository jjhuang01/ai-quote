import type { LoggerLike } from './logger';

export interface QueueItem {
  id: string;
  type: 'message' | 'feedback' | 'event' | 'command';
  payload: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  processedAt?: string;
  error?: string;
  retries: number;
}

export interface QueueConfig {
  maxRetries: number;
  concurrency: number;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxRetries: 3,
  concurrency: 1
};

export class QueueManager {
  private queue: QueueItem[] = [];
  private processing: Set<string> = new Set();
  private readonly config: QueueConfig;
  private readonly logger: LoggerLike;
  private handlers: Map<QueueItem['type'], (payload: unknown) => Promise<void>> = new Map();

  public constructor(logger: LoggerLike, config?: Partial<QueueConfig>) {
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public registerHandler(type: QueueItem['type'], handler: (payload: unknown) => Promise<void>): void {
    this.handlers.set(type, handler);
  }

  public async enqueue(type: QueueItem['type'], payload: unknown): Promise<QueueItem> {
    const item: QueueItem = {
      id: this.generateId(),
      type,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
      retries: 0
    };
    this.queue.push(item);
    this.logger.info('Queue item enqueued.', { id: item.id, type });
    void this.processNext();
    return item;
  }

  public getAll(): QueueItem[] {
    return [...this.queue];
  }

  public getPending(): QueueItem[] {
    return this.queue.filter(item => item.status === 'pending');
  }

  public getCompleted(): QueueItem[] {
    return this.queue.filter(item => item.status === 'completed');
  }

  public getFailed(): QueueItem[] {
    return this.queue.filter(item => item.status === 'failed');
  }

  public getById(id: string): QueueItem | undefined {
    return this.queue.find(item => item.id === id);
  }

  public async clear(): Promise<void> {
    this.queue = [];
    this.processing.clear();
    this.logger.info('Queue cleared.');
  }

  public async clearCompleted(): Promise<void> {
    this.queue = this.queue.filter(item => item.status !== 'completed');
    this.logger.info('Completed items cleared from queue.');
  }

  public getStatus(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  } {
    return {
      total: this.queue.length,
      pending: this.queue.filter(i => i.status === 'pending').length,
      processing: this.processing.size,
      completed: this.queue.filter(i => i.status === 'completed').length,
      failed: this.queue.filter(i => i.status === 'failed').length
    };
  }

  private async processNext(): Promise<void> {
    if (this.processing.size >= this.config.concurrency) {
      return;
    }

    const next = this.queue.find(item => item.status === 'pending');
    if (!next) {
      return;
    }

    this.processing.add(next.id);
    next.status = 'processing';

    try {
      const handler = this.handlers.get(next.type);
      if (!handler) {
        throw new Error(`No handler registered for type: ${next.type}`);
      }
      await handler(next.payload);
      next.status = 'completed';
      next.processedAt = new Date().toISOString();
      this.logger.info('Queue item completed.', { id: next.id, type: next.type });
    } catch (error) {
      next.retries += 1;
      if (next.retries >= this.config.maxRetries) {
        next.status = 'failed';
        next.error = error instanceof Error ? error.message : String(error);
        this.logger.error('Queue item failed.', { id: next.id, error: next.error });
      } else {
        next.status = 'pending';
        this.logger.warn('Queue item retry.', { id: next.id, retry: next.retries });
      }
    } finally {
      this.processing.delete(next.id);
      void this.processNext();
    }
  }

  private generateId(): string {
    return `queue_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
