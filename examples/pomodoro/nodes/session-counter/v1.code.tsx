import { usePatchcadParam } from '@patchcad/preview-runtime';

const SessionCounter: React.FC = () => {
  const workMinutes = usePatchcadParam('session-counter', 'workMinutes', 25);
  const breakMinutes = usePatchcadParam('session-counter', 'breakMinutes', 5);
  // Placeholder for session counter logic
  return (
    <div>
      <p>Work Session: {workMinutes} minutes</p>
      <p>Break Session: {breakMinutes} minutes</p>
    </div>
  );
};

export { SessionCounter };