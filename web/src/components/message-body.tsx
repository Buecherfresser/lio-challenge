import type { ReactNode } from "react"
import type { Message } from "@shared/api.ts"
import { isTranslated, languageName } from "@/lib/format"
import { cn } from "@/lib/utils"

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      {children}
    </div>
  )
}

/**
 * The text of a mail. Mails in another language show the original and the English text side by side.
 * Pass `original` to replace the original text with something else, for example an editor.
 */
export function MessageBody({
  message,
  original,
  className,
}: {
  message: Message
  original?: ReactNode
  className?: string
}) {
  const text = "text-sm leading-relaxed break-words whitespace-pre-wrap"
  const originalNode = original ?? <p className={text}>{message.body_original}</p>
  if (!isTranslated(message)) return <div className={className}>{originalNode}</div>
  // Side by side as soon as the surrounding column is wide enough, whatever the window size.
  return (
    <div className={cn("@container", className)}>
      <div className="grid gap-4 @sm:grid-cols-2">
        <Column label={`Original (${languageName(message.language)})`}>{originalNode}</Column>
        <Column label="English">
          <p className={cn(text, "text-muted-foreground")}>{message.body_en}</p>
        </Column>
      </div>
    </div>
  )
}
