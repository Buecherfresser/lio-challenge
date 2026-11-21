import { Link, Navigate, Route, Routes, useSearchParams } from "react-router"
import { AppLayout, ManagementLayout } from "@/components/app-layout"
import { EmptyState } from "@/components/states"
import { BUYER_HOME } from "@/lib/nav"
import { InboxPage } from "@/pages/inbox"
import { LogPage } from "@/pages/log"
import { ManagementPage } from "@/pages/management"
import { PartsPage } from "@/pages/parts"
import { OverviewPage } from "@/pages/overview"
import { TodoPage } from "@/pages/todo"

/** Old links to the approvals page land on the decisions in the to-do list. */
function ApprovalsRedirect() {
  const [searchParams] = useSearchParams()
  const done = searchParams.get("tab") === "decided"
  return <Navigate to={`/todo?kind=decision${done ? "&show=done" : ""}`} replace />
}

export default function App() {
  return (
    <Routes>
      {/* Two views: management (one number and the map) and the buyer's workspace. */}
      <Route element={<ManagementLayout />}>
        <Route index element={<ManagementPage />} />
      </Route>
      <Route element={<AppLayout />}>
        <Route path={BUYER_HOME.slice(1)} element={<OverviewPage />} />
        <Route path="todo" element={<TodoPage />} />
        <Route path="approvals" element={<ApprovalsRedirect />} />
        <Route path="parts" element={<PartsPage />} />
        <Route path="parts/:part_id" element={<PartsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="log" element={<LogPage />} />
        <Route
          path="*"
          element={
            <div className="p-6">
              <EmptyState>
                <span>
                  This page does not exist.{" "}
                  <Link to={BUYER_HOME} className="font-medium text-foreground underline underline-offset-4">
                    Go to the overview
                  </Link>
                </span>
              </EmptyState>
            </div>
          }
        />
      </Route>
    </Routes>
  )
}
