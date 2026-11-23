import Modal from '../ui/Modal';

export default function ConfirmModal({
  isOpen = false,
  title = 'Confirm Action',
  message = 'Are you sure?',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm = () => {},
  onCancel = () => {},
  isDangerous = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-slate-400"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
              isDangerous
                ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500'
                : 'bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-500'
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-slate-600">{message}</p>
    </Modal>
  );
}
