import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import { TopBarSlotsProvider } from "@/components/TopBarSlots";
import { AppDataProvider } from "@/components/app/AppDataProvider";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppDataProvider>
      <TopBarSlotsProvider>
        <div className="tesbo-app-shell flex h-screen text-[var(--foreground)]">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            <TopBar />
            <div className="tesbo-page">{children}</div>
          </main>
        </div>
      </TopBarSlotsProvider>
    </AppDataProvider>
  );
}
