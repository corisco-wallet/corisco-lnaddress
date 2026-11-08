import { describeInvoiceStore } from "./invoice-store-contract";
import { MemoryInvoiceStore } from "./memory-invoice-store";
import { MemoryUserStore } from "./memory-store";

describeInvoiceStore("in-memory", async () => {
  const users = new MemoryUserStore();
  return { store: new MemoryInvoiceStore(users), users };
});
