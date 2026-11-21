import { Link } from "react-router"
import type { ObjectRef } from "@shared/api.ts"
import { OBJECT_TYPE_LABEL, objectHref } from "@/lib/format"
import { cn } from "@/lib/utils"

export function ObjectLink({ object, className }: { object: ObjectRef; className?: string }) {
  return (
    <Link
      to={objectHref(object)}
      title={`${OBJECT_TYPE_LABEL[object.type]} ${object.id}`}
      onClick={(event) => event.stopPropagation()}
      className={cn("underline decoration-border underline-offset-4 hover:decoration-foreground", className)}
    >
      {object.label ?? object.id}
    </Link>
  )
}

export function PartLink({ partId, className }: { partId: string; className?: string }) {
  return <ObjectLink object={{ type: "part", id: partId }} className={className} />
}
