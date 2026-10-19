import { MemoryUserStore } from "./memory-store";
import { describeUserStore } from "./store-contract";

describeUserStore("in-memory", async () => ({ store: new MemoryUserStore() }));
