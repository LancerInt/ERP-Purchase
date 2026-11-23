import { Pencil, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import usePermissions from '../../hooks/usePermissions.js';

export default function ActionButtons({ moduleName, editPath, onDelete, row }) {
  const { canEdit, canDelete } = usePermissions();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
      {canEdit(moduleName) && editPath && (
        <button onClick={() => navigate(editPath)} aria-label="Edit" title="Edit"
          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          <Pencil size={16} />
        </button>
      )}
      {canDelete(moduleName) && onDelete && (
        <button onClick={() => onDelete(row)} aria-label="Delete" title="Delete"
          className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500">
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
}
