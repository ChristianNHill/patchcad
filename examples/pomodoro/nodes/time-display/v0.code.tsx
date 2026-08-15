import { ReactNode } from 'react';

const TimeDisplay = ({ time }: { time: string }) => (
  <div style={{ fontSize: '2rem', textAlign: 'center' }}>{time}</div>
);

export default TimeDisplay;
