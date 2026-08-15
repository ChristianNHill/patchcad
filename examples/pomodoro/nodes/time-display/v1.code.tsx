import usePatchcadParam from '@patchcad/preview-runtime/usePatchcadParam';

const TimeDisplay = () => {
  const time = usePatchcadParam('time-display', 'time', '00:00');
  return (
    <div style={{ fontSize: '2rem', textAlign: 'center' }}>{time}</div>
  );
};

const TimeDisplayCompact = () => {
  const time = usePatchcadParam('time-display', 'time', '00:00');
  return (
    <div style={{ fontSize: '1rem', textAlign: 'center' }}>{time}</div>
  );
};

export { TimeDisplay, TimeDisplayCompact };