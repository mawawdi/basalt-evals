import { OperationJournal } from "./journal.js";
import type { Page } from "../../contracts/src/catalog.js";

type RecordDecoder<T> = (value: unknown) => T;

/** A domain-owned codec is mandatory on both sides of the storage boundary. */
export class RecordRepository<T> {
  constructor(
    private readonly journal: OperationJournal,
    private readonly namespace: string,
    private readonly decode: RecordDecoder<T>,
  ) {}
  get(id: string): T | null {
    const value = this.journal.read<unknown>(this.namespace, id);
    return value === null ? null : this.decode(value);
  }
  require(id: string): T {
    const value = this.get(id);
    if (value === null) throw new Error(`The requested ${this.namespace} record is unavailable`);
    return value;
  }
  put(id: string, value: T): void {
    this.journal.put(this.namespace, id, this.decode(value));
  }
  list(): T[] {
    return this.journal.list<unknown>(this.namespace).map(this.decode);
  }
  page(input: Parameters<OperationJournal["page"]>[1] = {}): Page<T> {
    const result = this.journal.page<unknown>(this.namespace, input);
    return { ...result, items: result.items.map(this.decode) };
  }
  project(id: string, value: T, search: string, status: string, sort: string) {
    this.journal.project(this.namespace, id, { body: this.decode(value), search, status, sort });
  }
}
