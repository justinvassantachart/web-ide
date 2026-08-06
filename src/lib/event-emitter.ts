export type Listener<T> = (data: T) => void;

export class EventEmitter<T = void> {
    private listeners = new Set<Listener<T>>();

    public emit(data: T): void {
        for (const listener of this.listeners) {
            listener(data);
        }
    }

    public subscribe(listener: Listener<T>): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
