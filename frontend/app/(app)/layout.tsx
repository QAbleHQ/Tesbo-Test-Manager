import Sidebar from "@/components/Sidebar";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-[var(--background)]">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="tesbo-page">{children}</div>
      </main>
    </div>
  );
}
