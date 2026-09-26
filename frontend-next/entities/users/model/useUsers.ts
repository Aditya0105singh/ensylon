import { SWRConfiguration } from "swr";
import useSWRImmutable from "swr/immutable";
import { useApi } from "@/shared/lib/hooks/useApi";

// Kept minimal and self-contained (not imported from app/(keep)/settings/)
// since alert-assignee.tsx - a real widget used by Dashboard's preset alerts
// table - only needs these three fields for its avatar/name lookup.
export interface User {
  name: string;
  email: string;
  picture?: string;
}

export const useUsers = (options: SWRConfiguration = {}) => {
  const api = useApi();

  return useSWRImmutable<User[]>(
    api.isReady() ? "/auth/users" : null,
    (url) => api.get(url),
    options
  );
};
