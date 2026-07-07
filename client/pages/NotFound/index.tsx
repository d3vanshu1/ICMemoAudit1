import { useNavigate } from "react-router";
import { AlertTriangle } from "lucide-react";
import ICButton from "@/components/ic/ui/ICButton";

export { NotFoundPage as Component };

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-center h-full min-h-screen bg-ic-dark">
      <div className="text-center max-w-md px-6">
        <div className="w-16 h-16 rounded-full bg-ic-coral/15 flex items-center justify-center mx-auto mb-6">
          <AlertTriangle className="w-8 h-8 text-ic-coral" />
        </div>
        <h1 className="text-2xl font-bold text-ic-text mb-2">Page Not Found</h1>
        <p className="text-sm text-ic-muted mb-6">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <ICButton onClick={() => navigate("/")}>Back to Deals</ICButton>
      </div>
    </div>
  );
}
