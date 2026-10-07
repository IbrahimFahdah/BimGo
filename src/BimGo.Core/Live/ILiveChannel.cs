// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// One side of a session's message exchange, whatever carries it: session folders (<see cref="FolderChannel"/>,
    /// the desktop app) or a WebSocket (<see cref="SocketChannel"/>, the browser viewer). Thread-safe; never throws
    /// from Send / TryReceive.
    /// </summary>
    public interface ILiveChannel : IDisposable
    {
        /// <summary>Raised (on a background thread) after new messages were queued.</summary>
        event Action MessageArrived;

        /// <summary>
        /// Sends a message.
        /// </summary>
        /// <param name="type">One of <see cref="MessageTypes"/>.</param>
        /// <param name="payload">The payload object (serialised), or null.</param>
        /// <param name="replyTo">The id of the message being answered, or null.</param>
        /// <returns>The sent envelope, or null if it could not be sent.</returns>
        Envelope Send(string type, object payload, string replyTo = null);

        /// <summary>Takes the next received message, if any.</summary>
        bool TryReceive(out Envelope envelope);
    }
}
