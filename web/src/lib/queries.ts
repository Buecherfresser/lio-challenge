import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ObjectType } from "@shared/api.ts"
import { api, type EventFilter, type MessageFolder } from "@/lib/api"
import { EVENTS_PAGE_SIZE } from "@/lib/config"

// Every query polls. The interval is set once on the QueryClient in main.tsx.

export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: api.overview })
export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: api.status })
export const useParts = () => useQuery({ queryKey: ["parts"], queryFn: api.parts })
export const useMap = () => useQuery({ queryKey: ["map"], queryFn: api.map })
export const usePart = (partId: string | undefined) =>
  useQuery({ queryKey: ["part", partId], queryFn: () => api.part(partId!), enabled: Boolean(partId) })
export const useDecisions = () => useQuery({ queryKey: ["decisions"], queryFn: api.decisions })
export const useThreads = () => useQuery({ queryKey: ["threads"], queryFn: api.threads })
export const useFolderMessages = (folder: MessageFolder) =>
  useQuery({ queryKey: ["messages", "folder", folder], queryFn: () => api.folderMessages(folder) })
export const useThreadMessages = (threadId: string | null) =>
  useQuery({
    queryKey: ["messages", "thread", threadId],
    queryFn: () => api.threadMessages(threadId!),
    enabled: Boolean(threadId),
  })
export const useTasks = () => useQuery({ queryKey: ["tasks"], queryFn: api.tasks })

export const useFacts = (objectType: ObjectType | undefined, objectId: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ["facts", objectType, objectId],
    queryFn: () => api.facts(objectType!, objectId!),
    enabled: enabled && Boolean(objectType && objectId),
  })

export const useEvents = (filter: EventFilter) =>
  useInfiniteQuery({
    queryKey: ["events", filter],
    queryFn: ({ pageParam }) => api.events(filter, EVENTS_PAGE_SIZE, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) =>
      lastPage.length === EVENTS_PAGE_SIZE ? lastPage[lastPage.length - 1].id : undefined,
    placeholderData: keepPreviousData,
  })

/** Runs a POST and then reloads everything, because one action can change several lists. */
function useAction<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries(),
  })
}

export const useApproveDecision = () => useAction((id: number) => api.approveDecision(id))
export const useRejectDecision = () =>
  useAction(({ id, reason }: { id: number; reason: string }) => api.rejectDecision(id, reason))
export const useSendMessage = () =>
  useAction(({ id, body }: { id: number; body: string }) => api.sendMessage(id, body))
export const useDiscardMessage = () => useAction((id: number) => api.discardMessage(id))
export const useTaskDone = () => useAction((id: number) => api.taskDone(id))
export const useRunAll = () => useAction(() => api.runAll())
export const useReplayNext = () => useAction(() => api.replayNext())
