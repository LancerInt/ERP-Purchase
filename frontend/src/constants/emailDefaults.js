// Standing CC recipients auto-added to every RFQ and Purchase Order email.
//
// Pre-filled into the CC field on the Send-Email screens so the sender doesn't
// have to type them each time. They render as removable pills, so the sender
// can drop any of them for a one-off send via the pill's × button.
//
// The trailing ", " makes BOTH addresses render as committed pills immediately
// (the CC field treats the text after the last comma as the still-being-typed
// token). Change this list to update the default recipients everywhere.
export const DEFAULT_PURCHASE_CC = 'ravindranathank@gmail.com, ram@ssbiochem.com, ';
