import { useNavigate } from 'react-router-dom';

/**
 * Real 404 for unmatched routes. Replaces the old catch-all that bounced
 * even a logged-in user to /login on any typo'd URL.
 */
export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="min-h-dvh flex items-center justify-center p-4 sm:p-5 bg-slate-50">
      <div className="max-w-md w-full text-center bg-white border border-slate-200 rounded-xl shadow-sm p-8">
        <p className="text-5xl font-bold text-primary-600">404</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-800">Page not found</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          The page you’re looking for doesn’t exist or may have moved.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50"
          >
            Go back
          </button>
          <button
            onClick={() => navigate('/home')}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
