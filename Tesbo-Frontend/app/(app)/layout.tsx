import Sidebar from "@/components/Sidebar";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--background)]">
        <div className="tesbo-page">{children}</div>
      </main>
    </div>
  );
}
