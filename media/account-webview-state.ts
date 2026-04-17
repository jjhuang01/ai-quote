export interface SearchableAccountLike {
  id: string;
  email: string;
  plan?: string;
}

export function filterAccountsForQuery<T extends SearchableAccountLike>(accounts: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return accounts;
  return accounts.filter((account) => {
    const emailMatch = account.email.toLowerCase().includes(normalized);
    const planMatch = (account.plan ?? '').toLowerCase().includes(normalized);
    return emailMatch || planMatch;
  });
}

export function getFilteredAccountIds<T extends SearchableAccountLike>(accounts: T[], query: string): string[] {
  return filterAccountsForQuery(accounts, query).map((account) => account.id);
}

export function normalizeAccountSelection(current: Set<string>, existingIds: string[]): Set<string> {
  const allowed = new Set(existingIds);
  return new Set([...current].filter((id) => allowed.has(id)));
}

export function clampAccountScrollTop(input: {
  scrollTop: number;
  itemCount: number;
  itemHeight: number;
  viewportHeight: number;
}): number {
  const totalHeight = Math.max(0, input.itemCount * input.itemHeight);
  const maxScrollTop = Math.max(0, totalHeight - Math.max(0, input.viewportHeight));
  return Math.min(Math.max(0, input.scrollTop), maxScrollTop);
}
