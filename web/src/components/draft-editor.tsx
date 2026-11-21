import { Send } from "lucide-react"
import { useState } from "react"
import type { Message } from "@shared/api.ts"
import { MessageBody } from "@/components/message-body"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { isTranslated } from "@/lib/format"
import { useDiscardMessage, useOverview, useSendMessage } from "@/lib/queries"

/** A mail that waits for approval: the text can be edited, then sent or discarded. */
export function DraftEditor({ message }: { message: Message }) {
  const [body, setBody] = useState(message.body_original)
  const send = useSendMessage()
  const discard = useDiscardMessage()
  const { data: overview } = useOverview()
  const busy = send.isPending || discard.isPending
  const edited = body !== message.body_original

  return (
    <div className="space-y-3">
      <MessageBody
        message={message}
        original={
          <Textarea
            aria-label="Mail text"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-40 bg-background leading-relaxed"
          />
        }
      />
      {isTranslated(message) && edited && (
        <p className="text-xs text-muted-foreground">The English text shows the draft before your edits.</p>
      )}
      {/* The buttons stay in view while a long mail scrolls. */}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 bg-background/95 px-1 py-2 backdrop-blur">
        <Button
          variant="default"
          disabled={busy || !body.trim()}
          onClick={() => send.mutate({ id: message.id, body })}
        >
          <Send />
          Send
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => discard.mutate(message.id)}>
          Discard
        </Button>
        {(send.isError || discard.isError) && (
          <span className="text-xs text-muted-foreground">That did not work. Try again.</span>
        )}
        {overview?.mode.mail === "outbox" && (
          <span className="ml-auto text-xs text-muted-foreground">
            Outbox mode: the mail is stored and not delivered.
          </span>
        )}
      </div>
    </div>
  )
}
