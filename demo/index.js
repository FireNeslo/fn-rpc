import { value, api } from 'fn-reval'
import rpc, { duplex, load } from '../rpc.js'

const channel = new BroadcastChannel('my-app');



const client = duplex(
  function read(target) {
    channel.addEventListener('message', target)
  },
  function write(value) {
    channel.postMessage(value, '*')
  }
)

const [ server ] = rpc(window, async function *main(api) {
  const remote = api.document

  let form = remote.createElement('form')
  let input = remote.createElement('input')

  const button = remote.createElement('button')
  const output = document.createElement('pre')

  
  button.setAttribute('type', 'submit')
  button.textContent = 'Send'

  form.appendChild(input)
  form.appendChild(button)

  form.setAttribute('onsubmit', 'return false')

  remote.body.appendChild(form)
  document.body.appendChild(output)

  console.log(yield form.getAttribute('onsubmit'))

  let next = null

  form.addEventListener('submit', () => next())

  while(true) {
    await new Promise(done => next = done)

    const message = yield input.value

    output.appendChild(document.createTextNode(message+'\n'))

    console.log({ message })

    input.value = ''
  }
})


server.pipe(client).map(event => event.data).pipe(server)


