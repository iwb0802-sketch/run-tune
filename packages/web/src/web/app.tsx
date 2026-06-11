import { Route, Switch } from "wouter";
import { Toaster } from "sonner";
import { Provider } from "./components/provider";
import { AgentFeedback, RunableBadge } from "@runablehq/website-runtime";
import { Suspense, lazy } from "react";
import { useAuth } from "./hooks/useAuth";

const Home = lazy(() => import("./pages/Home"));
const ManualPage = lazy(() => import("./pages/ManualPage"));
const AuthPage = lazy(() => import("./pages/AuthPage"));

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/manual" component={ManualPage} />
      <Route>
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-muted-foreground">페이지를 찾을 수 없습니다.</p>
        </div>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <Provider>
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      }>
        <AppRoutes />
      </Suspense>
      <Toaster richColors position="bottom-right" />
      {import.meta.env.DEV && <AgentFeedback />}
      {<RunableBadge />}
    </Provider>
  );
}

export default App;
