const core = require('@actions/core');
const github = require('@actions/github');

try {
  const PROJECT_ID = core.getInput('PROJECT_ID');
  const API_KEY = core.getInput('API_KEY');
  const NEW_IMAGE = core.getInput('IMAGE');

  core.info(`Updating deployment to use image ${NEW_IMAGE}`);

  fetch(`https://api.zenifra.com/v1/project/${PROJECT_ID}/image`, {
    method: 'PATCH',
    body: JSON.stringify({
      image: NEW_IMAGE,
    }),
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': `${API_KEY}`
    }
  })
    .then((v) => {
      const receivedStatusCode = v.status;

      if (receivedStatusCode === 200) {
        core.info('Update deployment with success!')
        return;
      }

      core.error(`Failed to update image; Code ${receivedStatusCode}`)

      throw new Error(`Failed to update image; Code ${receivedStatusCode}`);
    })
    .catch((e) => {
      throw e;
    })
} catch (error) {
  core.setFailed(error.message);
}