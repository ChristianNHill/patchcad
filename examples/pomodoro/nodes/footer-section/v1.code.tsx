// @nodes/footer-section
import React from 'react';
import { usePatchcadParam } from '@patchcad/preview-runtime';

const FooterSection = () => {
  const workMinutes = usePatchcadParam('footer-section', 'workMinutes', 25);
  const breakMinutes = usePatchcadParam('footer-section', 'breakMinutes', 5);
  const sessionCount = usePatchcadParam('footer-section', 'sessionCount', 0);

  return (
    <div className='footer-section'>
      <p>Work: {workMinutes} minutes</p>
      <p>Break: {breakMinutes} minutes</p>
      <p>Sessions: {sessionCount}</p>
    </div>
  );
};

export { FooterSection };
