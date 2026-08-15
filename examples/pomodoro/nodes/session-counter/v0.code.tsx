import React, { useState } from 'react';

const SessionCounter = () => {
  const [sessionCount, setSessionCount] = useState(0);

  return (
    <div style={{ textAlign: 'center' }}>
      <h1>Session Counter</h1>
      <p>Total Sessions: {sessionCount}</p>
    </div>
  );
};

export default SessionCounter;