import { ShieldX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../layout/MainLayout';

export default function PermissionDenied() {
  const navigate = useNavigate();

  return (
    <MainLayout>
      <div className="flex flex-col items-center justify-center py-24">
        <div className="bg-red-50 border border-red-200 rounded-full p-4 sm:p-5 mb-4">
          <ShieldX size={48} className="text-red-500" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Permission Denied</h1>
        <p className="text-slate-600 mb-4 text-center max-w-md">
          You do not have permission to access this page. Please contact your administrator to request access.
        </p>
        <button
          onClick={() => navigate(-1)}
          className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700"
        >
          Go Back
        </button>
      </div>
    </MainLayout>
  );
}
